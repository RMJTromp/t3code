import {
  CommandId,
  normalizeWorkspacePath,
  WorkspaceError,
  WorkspaceId,
  WorkspaceProjectFileConfig,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  type Workspace,
  type WorkspaceArchiveInput,
  type WorkspaceCreateInput,
  WorkspaceIssue,
  type WorkspacePullRequest,
  type ProjectWorkspaceScripts,
  type WorkspaceRunScriptInput,
  type WorkspaceRunningScript,
  type WorkspaceStateEvent,
  type WorkspaceLogEvent,
  type WorkspaceScriptKind,
  type WorkspaceStatus,
  type WorkspaceFirstMessage,
  type WorkspaceUpdateOutcome,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  WORKSPACE_ARCHIVE_TERMINAL_ID,
  WORKSPACE_SETUP_TERMINAL_ID,
  workspaceMergePrompt,
  workspaceScriptTerminalId,
} from "@t3tools/contracts";
import { formatGeneratedBranchName } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import { nameWorkspaceBranch } from "./branchNaming.ts";
import { pickCityName } from "./cityNames.ts";
import { WorkspaceOwnership } from "./WorkspaceOwnership.ts";
import { runWorkspaceScript, trimWorkspaceLog } from "./WorkspaceScriptRunner.ts";
import { WorkspaceStore, type StoredWorkspace } from "./WorkspaceStore.ts";

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly create: (input: WorkspaceCreateInput) => Effect.Effect<Workspace, WorkspaceError>;
    readonly archive: (input: WorkspaceArchiveInput) => Effect.Effect<Workspace, WorkspaceError>;
    readonly unarchive: (workspaceId: WorkspaceId) => Effect.Effect<Workspace, WorkspaceError>;
    /** Resumes whatever a restart or failure interrupted. */
    readonly retry: (workspaceId: WorkspaceId) => Effect.Effect<Workspace, WorkspaceError>;
    /**
     * Merges origin's copy of the target, which follows an open pull request's base. A merge
     * that conflicts is undone and handed to an agent in a new chat of the workspace.
     */
    readonly updateFromBase: (workspaceId: WorkspaceId) => Effect.Effect<
      {
        readonly workspace: Workspace;
        readonly outcome: WorkspaceUpdateOutcome;
        readonly pushed: boolean;
        readonly agentThreadId: ThreadId | null;
      },
      WorkspaceError
    >;
    /**
     * Keeps each idle workspace with a ready-for-review pull request and nothing unpushed merged
     * with origin's target branch, and pushes; a conflict goes to an agent. It merges once the
     * branch has been behind for 5 minutes, at most every 15, and once per target commit. A
     * workspace whose pull request merged settles its chats and archives itself.
     */
    readonly autoUpdateFromBase: Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<Workspace>>;
    /** Workspaces plus every project's scripts, re-sent whole on each change; both are small. */
    readonly stream: Stream.Stream<WorkspaceStateEvent>;
    readonly logStream: (workspaceId: WorkspaceId) => Stream.Stream<WorkspaceLogEvent>;
    /** Runs one of the project's extra scripts in a terminal of the chat in view. */
    readonly runProjectScript: (
      input: WorkspaceRunScriptInput,
    ) => Effect.Effect<Workspace, WorkspaceError>;
    readonly setProjectScripts: (
      scripts: ProjectWorkspaceScripts,
    ) => Effect.Effect<ProjectWorkspaceScripts, WorkspaceError>;
    /** Open issues through the GitHub CLI, which brings its own auth. */
    readonly listIssues: (input: {
      readonly projectId: ProjectId;
      readonly query?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<WorkspaceIssue>, WorkspaceError>;
    readonly listPullRequests: (input: {
      readonly projectId: ProjectId;
      readonly query?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<WorkspacePullRequest>, WorkspaceError>;
    readonly readIssue: (input: {
      readonly projectId: ProjectId;
      readonly number: number;
    }) => Effect.Effect<WorkspaceIssue, WorkspaceError>;
  }
>()("t3/fork/workspaces/WorkspaceService") {}

const OUTBOX_DRAIN_TIMEOUT = Duration.seconds(30);
const GH_LIST_LIMIT = 50;
// A first message stays readable; the agent can still `gh issue view` the rest.
const ISSUE_BODY_MAX_CHARS = 20_000;
const decodeIssues = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(WorkspaceIssue)),
);
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceIssue));
const GhPullRequestState = Schema.Struct({
  state: Schema.String,
  isDraft: Schema.Boolean,
  mergedAt: Schema.NullOr(Schema.String),
  baseRefName: Schema.String,
});
type GhPullRequestState = typeof GhPullRequestState.Type;
const decodeGhPullRequestState = Schema.decodeUnknownOption(
  Schema.fromJsonString(GhPullRequestState),
);
const PULL_REQUEST_LOOKUP_TTL_MS = 5 * 60_000;
const decodeGhPullRequestHead = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ headRefName: Schema.String, isCrossRepository: Schema.Boolean }),
  ),
);

/**
 * How long a branch must trail its target before merging on its own, and how far apart those
 * merges stay, so a burst of merges on the target lands as one. Tests shorten them.
 */
export const AutoMergeTiming = Context.Reference<{
  readonly behindForMs: number;
  readonly intervalMs: number;
}>("t3/fork/workspaces/AutoMergeTiming", {
  defaultValue: () => ({ behindForMs: 5 * 60_000, intervalMs: 15 * 60_000 }),
});

export function autoMergeDue(input: {
  readonly now: number;
  readonly behindSince: number;
  readonly lastMergeAt: number | undefined;
  readonly timing: typeof AutoMergeTiming.Service;
}): boolean {
  return (
    input.now - input.behindSince >= input.timing.behindForMs &&
    (input.lastMergeAt === undefined || input.now - input.lastMergeAt >= input.timing.intervalMs)
  );
}
const decodeGhPullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        url: Schema.String,
        headRefName: Schema.String,
        baseRefName: Schema.String,
        isDraft: Schema.Boolean,
      }),
    ),
  ),
);
const decodeProjectFileConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorkspaceProjectFileConfig),
);

const workspaceError = (reason: WorkspaceError["reason"], message: string) =>
  new WorkspaceError({ reason, message });

const describe = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    return String((cause as { detail: unknown }).detail);
  }
  return String(cause);
};

const gitFailure = (message: string) => (cause: unknown) =>
  workspaceError("git-failed", `${message}: ${describe(cause)}`);

const isBusy = (thread: {
  readonly activeRunId: unknown;
  readonly activityRunStatus?: unknown;
}): boolean => thread.activeRunId !== null || (thread.activityRunStatus ?? null) !== null;

/** Busy, or still running a background subagent or command after its turn ended. */
const isBusyInBackground = (thread: {
  readonly activeRunId: unknown;
  readonly activityRunStatus?: unknown;
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown> | undefined;
}): boolean => isBusy(thread) || (thread.pendingBackgroundTasks?.length ?? 0) > 0;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** A new branch still named after its city waits for a turn that shows the task. */
const awaitingBranchName = (workspace: Workspace): string | null =>
  workspace.checkout.type === "new" &&
  workspace.branch !== null &&
  (workspace.branch === workspace.name || workspace.branch.endsWith(`/${workspace.name}`))
    ? workspace.branch
    : null;
const isWorkspaceError = Schema.is(WorkspaceError);

export const make = Effect.gen(function* () {
  const store = yield* WorkspaceStore;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const terminals = yield* TerminalManager.TerminalManager;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const ownership = yield* WorkspaceOwnership;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const newId = random.uuidV4();
  const samePath = (left: string | null, right: string): boolean =>
    left !== null &&
    normalizeWorkspacePath(path.resolve(left)) === normalizeWorkspacePath(path.resolve(right));

  const records = new Map<WorkspaceId, StoredWorkspace>();
  const projectScripts = new Map<ProjectId, ProjectWorkspaceScripts>();
  // The created path and its real path, so guards match either spelling.
  const realPaths = new Map<WorkspaceId, string>();
  const logListeners = new Map<WorkspaceId, Set<(event: WorkspaceLogEvent) => void>>();
  const locks = new Map<WorkspaceId, Semaphore.Semaphore>();
  // Name picking reads git and the record set, so creates take turns.
  const createLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<WorkspaceStateEvent>();
  const backgroundScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));

  /** Scripts with no chat to show them (archive, older records) run on this terminal owner. */
  const workspaceTerminalThread = (workspaceId: WorkspaceId) => `fork-workspace-${workspaceId}`;

  const snapshot = (): ReadonlyArray<Workspace> =>
    Array.from(records.values(), (record) => record.workspace);
  const list = Effect.sync(snapshot);
  const state = (): WorkspaceStateEvent => ({
    workspaces: snapshot(),
    projectScripts: Array.from(projectScripts.values()),
  });

  const lockFor = (workspaceId: WorkspaceId) => {
    let lock = locks.get(workspaceId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(workspaceId, lock);
    }
    return lock;
  };
  const locked = <A, E>(workspaceId: WorkspaceId, effect: Effect.Effect<A, E>) =>
    lockFor(workspaceId).withPermits(1)(effect);

  const syncOwnership = (workspace: Workspace) =>
    ownership.set(
      workspace.id,
      [
        workspace.worktreePath,
        ...(realPaths.has(workspace.id) ? [realPaths.get(workspace.id)!] : []),
      ],
      { workspaceId: workspace.id, status: workspace.status, setupPending: workspace.setupPending },
    );

  const recordRealPath = (workspace: Workspace) =>
    fileSystem.realPath(workspace.worktreePath).pipe(
      Effect.map((real) => {
        realPaths.set(workspace.id, real);
        syncOwnership(workspace);
      }),
      Effect.ignore,
    );

  const put = Effect.fn("WorkspaceService.put")(function* (record: StoredWorkspace) {
    // Saved first, so clients never see a state a restart would lose.
    yield* store.save(record);
    records.set(record.workspace.id, record);
    syncOwnership(record.workspace);
    yield* PubSub.publish(changes, state());
    return record.workspace;
  });

  const get = (workspaceId: WorkspaceId) =>
    Effect.suspend(() => {
      const record = records.get(workspaceId);
      return record
        ? Effect.succeed(record)
        : Effect.fail(workspaceError("not-found", "This workspace no longer exists."));
    });

  // Turn tracking writes outside the per-workspace locks, so every read-modify-write takes turns.
  const writeLock = yield* Semaphore.make(1);
  const update = (workspaceId: WorkspaceId, change: (record: StoredWorkspace) => StoredWorkspace) =>
    writeLock.withPermits(1)(Effect.flatMap(get(workspaceId), (record) => put(change(record))));

  const setStatus = (
    workspaceId: WorkspaceId,
    status: WorkspaceStatus,
    fields: Partial<Workspace> = {},
  ) =>
    update(workspaceId, (record) => ({
      ...record,
      workspace: { ...record.workspace, status, ...fields },
    }));

  const appendLog = (workspaceId: WorkspaceId, text: string) => {
    const record = records.get(workspaceId);
    if (!record) return;
    records.set(workspaceId, { ...record, log: trimWorkspaceLog(record.log + text) });
    for (const listener of logListeners.get(workspaceId) ?? []) {
      listener({ type: "append", text });
    }
  };

  const resetLog = (workspaceId: WorkspaceId, header: string) => {
    const record = records.get(workspaceId);
    if (!record) return;
    records.set(workspaceId, { ...record, log: header });
    for (const listener of logListeners.get(workspaceId) ?? []) {
      listener({ type: "snapshot", text: header });
    }
  };

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => workspaceError("project-not-found", "The project could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(workspaceError("project-not-found", "The project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args, cwd }).pipe(
      Effect.map((output) => ({ ok: output.code === 0, stdout: output.stdout.trim() })),
      Effect.orElseSucceed(() => ({ ok: false, stdout: "" })),
    );

  const resolveDefaultBranch = Effect.fn("WorkspaceService.resolveDefaultBranch")(function* (
    root: string,
  ) {
    const remoteHead = yield* runGit(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead.ok && remoteHead.stdout.startsWith("origin/")) {
      return remoteHead.stdout.slice("origin/".length);
    }
    const current = yield* runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return current.ok && current.stdout !== "HEAD" ? current.stdout : "main";
  });

  const listBranchNames = (root: string) =>
    runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes/origin",
    ]).pipe(Effect.map((result) => new Set(result.ok ? result.stdout.split("\n") : [])));

  const worktreeParent = Effect.fn("WorkspaceService.worktreeParent")(function* (root: string) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(gitFailure("Could not read settings")),
    );
    const parent = resolveWorktreesDirectory(
      settings.worktreesDirectory,
      config.worktreesDir,
      path,
      home,
    );
    if (parent === null) {
      return yield* workspaceError(
        "git-failed",
        "The worktree location must be an absolute folder. Change it in Settings → Storage.",
      );
    }
    // Same layout upstream uses, so its managed-worktree checks still apply.
    return path.join(parent, path.basename(path.resolve(root)));
  });

  const readProjectFileConfig = (worktreePath: string) =>
    fileSystem.readFileString(path.join(worktreePath, "t3.json")).pipe(
      Effect.map((text) => Option.getOrUndefined(decodeProjectFileConfig(text))),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * Settings win, then `workspace.setup`/`archive` from the branch's t3.json.
   * Setup then falls back to the project's setup action and t3.json's
   * `runOnWorktreeCreate` script. Archive has no further fallback: settle
   * scripts serve a different event.
   */
  const resolveScript = Effect.fn("WorkspaceService.resolveScript")(function* (
    workspace: Workspace,
    kind: WorkspaceScriptKind,
  ) {
    const configured = projectScripts.get(workspace.projectId);
    const fromSettings = kind === "setup" ? configured?.setup : configured?.archive;
    if (fromSettings !== undefined && fromSettings.trim().length > 0) return fromSettings;
    const fileConfig = yield* readProjectFileConfig(workspace.worktreePath);
    const fromFile =
      kind === "setup" ? fileConfig?.workspace?.setup : fileConfig?.workspace?.archive;
    if (fromFile !== undefined && fromFile.trim().length > 0) return fromFile;
    if (kind === "archive") return null;
    const project = yield* loadProject(workspace.projectId);
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const fromProject =
      settings === null ? null : setupProjectScript(resolveProjectScripts(settings, project));
    if (fromProject !== null) return fromProject.command;
    return (
      fileConfig?.scripts?.find((script) => script.runOnWorktreeCreate === true)?.command ?? null
    );
  });

  const scriptEnv = (workspace: Workspace, projectRoot: string) =>
    projectScriptRuntimeEnv({
      project: { cwd: projectRoot },
      worktreePath: workspace.worktreePath,
      extraEnv: {
        T3_WORKSPACE_NAME: workspace.name,
        T3_WORKSPACE_PATH: workspace.worktreePath,
        T3_ROOT_PATH: projectRoot,
        T3_DEFAULT_BRANCH: workspace.baseRef ?? "",
      },
    });

  /** Returns true when the script succeeded or there was none. */
  const runScript = Effect.fn("WorkspaceService.runScript")(function* (
    workspaceId: WorkspaceId,
    kind: WorkspaceScriptKind,
  ) {
    const { workspace } = yield* get(workspaceId);
    const command = yield* resolveScript(workspace, kind);
    if (command === null) return true;
    const project = yield* loadProject(workspace.projectId);
    const startedAt = yield* nowIso;
    resetLog(workspaceId, `$ ${command}\n`);
    yield* update(workspaceId, (record) => ({
      ...record,
      workspace: {
        ...record.workspace,
        lastScript: { kind, command, phase: "running", exitCode: null, startedAt, endedAt: null },
      },
    }));
    const terminal =
      kind === "setup" && workspace.setupTerminal !== null
        ? workspace.setupTerminal
        : {
            threadId: workspaceTerminalThread(workspace.id),
            terminalId:
              kind === "setup" ? WORKSPACE_SETUP_TERMINAL_ID : WORKSPACE_ARCHIVE_TERMINAL_ID,
          };
    const result = yield* runWorkspaceScript({
      threadId: terminal.threadId,
      terminalId: terminal.terminalId,
      command,
      cwd: workspace.worktreePath,
      env: scriptEnv(workspace, project.workspaceRoot),
      onOutput: (text) => appendLog(workspaceId, text),
    }).pipe(
      Effect.provideService(TerminalManager.TerminalManager, terminals),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const succeeded = result.exitCode === 0;
    appendLog(
      workspaceId,
      `\n[${kind} ${succeeded ? "finished" : "failed"}${
        result.exitCode === null ? "" : ` with exit code ${result.exitCode}`
      }]\n`,
    );
    const endedAt = yield* nowIso;
    yield* update(workspaceId, (record) => ({
      ...record,
      workspace: {
        ...record.workspace,
        lastScript: {
          kind,
          command,
          phase: succeeded ? "succeeded" : "failed",
          exitCode: result.exitCode,
          startedAt,
          endedAt,
        },
      },
    }));
    return succeeded;
  });

  const memberThreads = (workspace: Workspace) =>
    threads
      .getShellSnapshot({
        location: "active",
        projectId: workspace.projectId,
        worktreePath: workspace.worktreePath,
      })
      .pipe(
        // The snapshot also carries the threads its forks came from, wherever they ran.
        Effect.map(({ threads: shells }) =>
          shells.filter(
            (shell) =>
              shell.lineage.sideChat !== true &&
              samePath(shell.worktreePath, workspace.worktreePath),
          ),
        ),
        Effect.mapError(() =>
          workspaceError("invalid-state", "Could not read the workspace's chats."),
        ),
      );

  const isWorkspaceChat = (
    workspace: Workspace,
    thread: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly lineage: { readonly relationshipToParent: string | null };
    },
  ) =>
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.projectId === workspace.projectId &&
    samePath(thread.worktreePath, workspace.worktreePath);

  /** Naming moves every chat off the city branch; the workspace follows. */
  const followBranchRename = Effect.fn("WorkspaceService.followBranchRename")(function* (thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly lineage: { readonly relationshipToParent: string | null };
  }) {
    const { branch } = thread;
    if (branch === null) return;
    for (const { workspace } of Array.from(records.values())) {
      if (workspace.status === "archived" || workspace.branch === branch) continue;
      if (awaitingBranchName(workspace) === null || !isWorkspaceChat(workspace, thread)) continue;
      yield* update(workspace.id, (record) => ({
        ...record,
        workspace: { ...record.workspace, branch },
      }));
    }
  });

  /** A pushed branch, or one with a pull request, keeps its name: a rename would orphan both. */
  const branchIsPublished = Effect.fn("WorkspaceService.branchIsPublished")(function* (
    cwd: string,
    branch: string,
  ) {
    if ((yield* runGit(cwd, ["config", "--get", `branch.${branch}.remote`])).ok) return true;
    const remote = yield* runGit(cwd, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      `refs/remotes/*/${branch}`,
    ]);
    return remote.stdout.length > 0;
  });

  // One naming at a time, so a turn that ends mid-naming sees the renamed branch and stops.
  const namingLock = yield* Semaphore.make(1);
  /** Each finished turn retries until the model finds a task among the chores. */
  const nameBranchAfterTurn = Effect.fn("WorkspaceService.nameBranchAfterTurn")(
    function* (threadId: ThreadId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.worktreePath === null || shell.branch === null) return;
      const awaiting = Array.from(records.values()).some(
        ({ workspace }) =>
          workspace.status !== "archived" &&
          awaitingBranchName(workspace) === shell.branch &&
          isWorkspaceChat(workspace, shell),
      );
      if (!awaiting) return;
      if ((shell.pullRequests?.length ?? 0) > 0 || shell.branchPullRequest) return;
      if (yield* branchIsPublished(shell.worktreePath, shell.branch)) return;
      yield* nameWorkspaceBranch({
        threadId,
        projectId: shell.projectId,
        worktreePath: shell.worktreePath,
        branch: shell.branch,
      });
    },
    (effect, threadId) =>
      effect.pipe(
        namingLock.withPermits(1),
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace branch naming failed", { threadId, cause }),
        ),
      ),
  );

  /** Commits on origin's copy of the target branch that the branch lacks; null when unknown. */
  const countBehind = (workspace: Workspace) =>
    workspace.baseRef === null
      ? Effect.succeed(null)
      : runGit(workspace.worktreePath, [
          "rev-list",
          "--count",
          `HEAD..refs/remotes/origin/${workspace.baseRef}`,
        ]).pipe(
          Effect.map((result) => {
            const count = Number.parseInt(result.stdout, 10);
            return result.ok && Number.isSafeInteger(count) ? count : null;
          }),
        );

  const refreshBehind = Effect.fn("WorkspaceService.refreshBehind")(function* (
    workspaceId: WorkspaceId,
  ) {
    const record = records.get(workspaceId);
    if (record === undefined || record.workspace.status !== "ready") return;
    const behindBy = yield* countBehind(record.workspace);
    if (behindBy === record.workspace.behindBy) return;
    yield* update(workspaceId, (current) => ({
      ...current,
      workspace: { ...current.workspace, behindBy },
    }));
  });

  const fetchBase = (projectId: ProjectId, baseRef: string) =>
    loadProject(projectId).pipe(
      Effect.flatMap((project) =>
        git.fetchRemote({ cwd: project.workspaceRoot, remoteName: "origin", refName: baseRef }),
      ),
    );

  let behindTicks = 0;
  /** Counts every minute from refs already fetched; fetches each target branch every fifth. */
  const refreshAllBehind = Effect.gen(function* () {
    const live = snapshot().filter((workspace) => workspace.status === "ready");
    if (behindTicks++ % 5 === 0) {
      const targets = new Map<string, { projectId: ProjectId; baseRef: string }>();
      for (const { projectId, baseRef } of live) {
        if (baseRef !== null) targets.set(`${projectId}\n${baseRef}`, { projectId, baseRef });
      }
      yield* Effect.forEach(
        targets.values(),
        ({ projectId, baseRef }) => fetchBase(projectId, baseRef).pipe(Effect.ignore),
        { discard: true },
      );
    }
    yield* Effect.forEach(live, (workspace) => refreshBehind(workspace.id).pipe(Effect.ignore), {
      discard: true,
    });
    yield* autoUpdateFromBase;
  });

  const refreshBehindForThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) => {
        if (shell === null) return Effect.void;
        const owner = Array.from(records.values()).find(({ workspace }) =>
          isWorkspaceChat(workspace, shell),
        );
        return owner === undefined ? Effect.void : refreshBehind(owner.workspace.id);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("workspace behind count skipped", { threadId, cause }),
      ),
    );

  const isOpen = (pr: Option.Option<GhPullRequestState>) =>
    Option.exists(pr, ({ state }) => state === "OPEN");

  /** A stacked branch trails the branch its open pull request targets, which can be retargeted. */
  const followPullRequestBase = Effect.fn("WorkspaceService.followPullRequestBase")(function* (
    workspace: Workspace,
    pr: Option.Option<GhPullRequestState>,
  ) {
    if (Option.isNone(pr) || pr.value.state !== "OPEN") return workspace;
    const baseRef = pr.value.baseRefName;
    if (baseRef === workspace.baseRef) return workspace;
    yield* fetchBase(workspace.projectId, baseRef).pipe(Effect.ignore);
    behindSince.delete(workspace.id);
    const behindBy = yield* countBehind({ ...workspace, baseRef });
    appendLog(workspace.id, `Its pull request targets ${baseRef}, so the workspace does too.\n`);
    return yield* update(workspace.id, (current) => ({
      ...current,
      workspace: { ...current.workspace, baseRef, behindBy },
    }));
  });

  /**
   * Pushes the merge when the pull request is open and the merge is all there is to push, so
   * a merge never publishes work in progress.
   */
  const updateFromBase = (workspaceId: WorkspaceId, options: { readonly fresh: boolean }) =>
    locked(
      workspaceId,
      Effect.gen(function* () {
        const current = (yield* get(workspaceId)).workspace;
        if (current.status !== "ready") {
          return yield* workspaceError("invalid-state", "Wait for the workspace to be ready.");
        }
        const pr = yield* recentPullRequestOf(current, { fresh: options.fresh });
        const workspace = yield* followPullRequestBase(current, pr);
        const baseRef = workspace.baseRef;
        if (baseRef === null) {
          return yield* workspaceError("invalid-state", "This workspace has no target branch.");
        }
        const members = yield* memberThreads(workspace);
        if (members.some(isBusy)) {
          return yield* workspaceError(
            "agents-running",
            "Wait for the agents in this workspace to finish.",
          );
        }
        yield* fetchBase(workspace.projectId, baseRef).pipe(
          Effect.mapError(gitFailure(`Could not fetch origin/${baseRef}`)),
        );
        const behindBy = yield* countBehind(workspace);
        if (behindBy === null) {
          return yield* workspaceError("git-failed", `origin/${baseRef} could not be read.`);
        }
        let outcome: WorkspaceUpdateOutcome = "up-to-date";
        let push = false;
        if (behindBy > 0) {
          const cwd = workspace.worktreePath;
          const status = yield* runGit(cwd, ["status", "--porcelain"]);
          push =
            isOpen(pr) && status.ok && status.stdout === "" && !(yield* hasUnpushedCommits(cwd));
          // A merge, not a rebase: the branch may already be pushed or have a pull request.
          const merged = yield* runGit(workspace.worktreePath, [
            "merge",
            "--no-edit",
            `refs/remotes/origin/${baseRef}`,
          ]);
          if (merged.ok) {
            outcome = "updated";
          } else {
            yield* runGit(workspace.worktreePath, ["merge", "--abort"]);
            outcome = "needs-agent";
          }
        }
        const pushed = outcome === "updated" && push && (yield* pushBranch(workspace));
        if (outcome === "updated" && push && !pushed) {
          yield* Effect.logWarning("workspace merged its target branch but could not push", {
            workspaceId,
          });
        }
        const after = yield* countBehind(workspace);
        const updated = yield* update(workspaceId, (record) => ({
          ...record,
          workspace: { ...record.workspace, behindBy: after },
        }));
        const agentThreadId =
          outcome === "needs-agent"
            ? yield* launchMergeAgent(workspace, baseRef, members, push).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("workspace merge agent not started", {
                    workspaceId,
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              )
            : null;
        return { workspace: updated, outcome, pushed, agentThreadId };
      }),
    );

  const updateFromBaseNow = (workspaceId: WorkspaceId) =>
    updateFromBase(workspaceId, { fresh: true });

  // Paths of terminals running a command, from the same metadata the clients' red dot reads.
  const busyTerminals = new Map<string, string>();
  const trackTerminal = (terminal: TerminalSummary) => {
    const key = `${terminal.threadId}\u0000${terminal.terminalId}`;
    if (terminal.status === "running" && terminal.hasRunningSubprocess) {
      busyTerminals.set(key, terminal.worktreePath ?? terminal.cwd);
    } else {
      busyTerminals.delete(key);
    }
  };
  const onTerminalMetadata = (event: TerminalMetadataStreamEvent) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        busyTerminals.clear();
        for (const terminal of event.terminals) trackTerminal(terminal);
      } else if (event.type === "upsert") {
        trackTerminal(event.terminal);
      } else {
        busyTerminals.delete(`${event.threadId}\u0000${event.terminalId}`);
      }
    });

  /** The branch's pull request, merged or closed ones included; none without gh. */
  const pullRequestOf = (workspace: Workspace) =>
    processRunner
      .run({
        command: "gh",
        args: ["pr", "view", "--json", "state,isDraft,mergedAt,baseRefName"],
        cwd: workspace.worktreePath,
        timeout: "20 seconds",
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 ? decodeGhPullRequestState(output.stdout) : Option.none(),
        ),
        Effect.orElseSucceed(() => Option.none()),
      );

  // The sweep runs every minute; gh is asked about each branch at most every five.
  const pullRequestLookups = new Map<
    WorkspaceId,
    { readonly at: number; readonly pr: Option.Option<GhPullRequestState> }
  >();
  const recentPullRequestOf = Effect.fn("WorkspaceService.recentPullRequestOf")(function* (
    workspace: Workspace,
    options?: { readonly fresh?: boolean },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = pullRequestLookups.get(workspace.id);
    if (
      options?.fresh !== true &&
      cached !== undefined &&
      now - cached.at < PULL_REQUEST_LOOKUP_TTL_MS
    ) {
      return cached.pr;
    }
    const pr = yield* pullRequestOf(workspace);
    pullRequestLookups.set(workspace.id, { at: now, pr });
    return pr;
  });

  /** Commits the branch's upstream lacks; a branch without one counts as having them. */
  const hasUnpushedCommits = (cwd: string) =>
    runGit(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]).pipe(
      Effect.map((result) => !result.ok || result.stdout !== "0"),
    );

  /** Pushes to the branch's own upstream, which for a checked-out fork PR is not origin. */
  const pushBranch = Effect.fn("WorkspaceService.pushBranch")(function* (workspace: Workspace) {
    const cwd = workspace.worktreePath;
    const branch = yield* runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (!branch.ok) return false;
    const pushRemote = yield* runGit(cwd, ["config", `branch.${branch.stdout}.pushRemote`]);
    const remote = pushRemote.ok
      ? pushRemote
      : yield* runGit(cwd, ["config", `branch.${branch.stdout}.remote`]);
    const merge = yield* runGit(cwd, ["config", `branch.${branch.stdout}.merge`]);
    if (!remote.ok || !merge.ok) return false;
    const pushed = yield* processRunner
      .run({
        command: "git",
        args: ["push", remote.stdout, `HEAD:${merge.stdout}`],
        cwd,
        timeout: "2 minutes",
        env: { GIT_TERMINAL_PROMPT: "0" },
      })
      .pipe(Effect.orElseSucceed(() => ({ code: 1 })));
    return pushed.code === 0;
  });

  const launchMergeAgent = Effect.fn("WorkspaceService.launchMergeAgent")(function* (
    workspace: Workspace,
    baseRef: string,
    members: ReadonlyArray<OrchestrationV2ThreadShell>,
    push: boolean,
  ) {
    // The newest chat's model and access; plan mode would only describe the merge.
    const latest = members
      .filter((shell) => isWorkspaceChat(workspace, shell))
      .reduce<OrchestrationV2ThreadShell | null>(
        (newest, shell) =>
          newest === null ||
          DateTime.toEpochMillis(shell.updatedAt) > DateTime.toEpochMillis(newest.updatedAt)
            ? shell
            : newest,
        null,
      );
    if (latest === null) {
      yield* Effect.logWarning("workspace merge agent skipped: no chat to copy a model from", {
        workspaceId: workspace.id,
      });
      return null;
    }
    const launched = yield* threadLaunch.launch({
      commandId: CommandId.make(`fork-merge-agent:${workspace.id}:${yield* newId}`),
      projectId: workspace.projectId,
      title: `Merge origin/${baseRef}`,
      modelSelection: latest.modelSelection,
      runtimeMode: latest.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: workspace.worktreePath,
        ...(workspace.branch === null ? {} : { branch: workspace.branch }),
      },
      initialMessage: { text: workspaceMergePrompt(baseRef, { push }), attachments: [] },
      createdBy: "system",
      creationSource: "server",
    });
    return launched.threadId;
  });

  // The target commit each workspace last tried, so a failure is not retried until it moves.
  const autoUpdatedTo = new Map<WorkspaceId, string>();
  const autoMergeTiming = yield* AutoMergeTiming;
  const behindSince = new Map<WorkspaceId, number>();
  const autoMergedAt = new Map<WorkspaceId, number>();
  const autoUpdateWorkspace = Effect.fn("WorkspaceService.autoUpdateWorkspace")(function* (
    workspace: Workspace,
  ) {
    const baseRef = workspace.baseRef;
    if (workspace.status !== "ready" || workspace.setupPending || baseRef === null) return;
    const behindBy = yield* countBehind(workspace);
    const now = yield* Clock.currentTimeMillis;
    if (behindBy === null || behindBy === 0) {
      behindSince.delete(workspace.id);
      return;
    }
    const since = behindSince.get(workspace.id) ?? now;
    behindSince.set(workspace.id, since);
    const lastMergeAt = autoMergedAt.get(workspace.id);
    if (!autoMergeDue({ now, behindSince: since, lastMergeAt, timing: autoMergeTiming })) return;
    const cwd = workspace.worktreePath;
    const base = yield* runGit(cwd, ["rev-parse", `refs/remotes/origin/${baseRef}`]);
    if (!base.ok || autoUpdatedTo.get(workspace.id) === base.stdout) return;
    if (Array.from(busyTerminals.values()).some((busy) => samePath(busy, cwd))) return;
    if ((yield* memberThreads(workspace)).some(isBusyInBackground)) return;
    // Uncommitted files or unpushed commits mean work is in progress; wait until it is pushed.
    const status = yield* runGit(cwd, ["status", "--porcelain"]);
    if (!status.ok || status.stdout !== "") return;
    if (yield* hasUnpushedCommits(cwd)) return;
    const readyForReview = (pr: Option.Option<GhPullRequestState>) =>
      Option.exists(pr, ({ state, isDraft }) => state === "OPEN" && !isDraft);
    if (!readyForReview(yield* recentPullRequestOf(workspace))) return;
    // A merge moves the target ahead of the branch, often before the cache sees it merged;
    // merging that target back in would push to a finished branch.
    if (!readyForReview(yield* recentPullRequestOf(workspace, { fresh: true }))) return;
    autoUpdatedTo.set(workspace.id, base.stdout);
    autoMergedAt.set(workspace.id, now);
    behindSince.delete(workspace.id);
    yield* updateFromBase(workspace.id, { fresh: false });
  });

  // Workspaces whose archive started after their pull request merged, so a failed archive
  // script is not rerun every sweep.
  const archivedAfterMerge = new Set<WorkspaceId>();
  const archiveIfMerged = Effect.fn("WorkspaceService.archiveIfMerged")(function* (
    workspace: Workspace,
  ) {
    if (workspace.status !== "ready" || archivedAfterMerge.has(workspace.id)) return;
    const pr = yield* recentPullRequestOf(workspace);
    // A branch whose pull request merged before the workspace existed is being reused.
    const mergedAt = Option.getOrNull(pr)?.mergedAt;
    if (mergedAt == null || Date.parse(mergedAt) < Date.parse(workspace.createdAt)) return;
    const members = yield* memberThreads(workspace);
    if (members.some(isBusyInBackground)) return;
    for (const chat of members) {
      if (!isWorkspaceChat(workspace, chat) || chat.archivedAt !== null) continue;
      if (chat.settledAt !== null) continue;
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`fork-workspace-merged:${chat.id}:${yield* newId}`),
        threadId: chat.id,
      });
    }
    // Uncommitted files refuse the archive; it retries on the next sweep.
    yield* archive({ workspaceId: workspace.id });
    archivedAfterMerge.add(workspace.id);
    appendLog(workspace.id, "Its pull request merged, so the workspace archived itself.\n");
  });

  // The loop and a direct call never sweep at once, so one target commit starts one agent.
  const autoUpdateLock = yield* Semaphore.make(1);
  const autoUpdateFromBase: WorkspaceService["Service"]["autoUpdateFromBase"] = Effect.suspend(() =>
    Effect.forEach(
      snapshot(),
      (workspace) =>
        archiveIfMerged(workspace).pipe(
          Effect.andThen(() => {
            const current = records.get(workspace.id)?.workspace;
            return current?.status === "ready"
              ? recentPullRequestOf(current).pipe(
                  Effect.flatMap((pr) => followPullRequestBase(current, pr)),
                  Effect.flatMap(autoUpdateWorkspace),
                )
              : Effect.void;
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("workspace auto update skipped", {
              workspaceId: workspace.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    ),
  ).pipe(autoUpdateLock.withPermits(1));

  /** Kept on the workspace so archiving or deleting the chat does not drop it in the sidebar. */
  const recordTurn = Effect.fn("WorkspaceService.recordTurn")(function* (
    threadId: ThreadId,
    at: string,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return;
    for (const { workspace } of Array.from(records.values())) {
      if (workspace.status === "archived" || !isWorkspaceChat(workspace, shell)) continue;
      if (workspace.lastTurnAt !== null && workspace.lastTurnAt >= at) continue;
      yield* update(workspace.id, (record) =>
        record.workspace.lastTurnAt !== null && record.workspace.lastTurnAt >= at
          ? record
          : { ...record, workspace: { ...record.workspace, lastTurnAt: at } },
      );
    }
  });

  const changedFiles = (worktreePath: string) =>
    runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]).pipe(
      Effect.map((result) =>
        result.ok ? result.stdout.split("\n").filter((line) => line.length > 0) : [],
      ),
    );

  const fork = <A, E>(workspaceId: WorkspaceId, operation: string, effect: Effect.Effect<A, E>) =>
    locked(workspaceId, effect).pipe(
      Effect.catchCause((cause) =>
        setStatus(workspaceId, "failed", { error: `${operation} failed: ${describe(cause)}` }).pipe(
          Effect.ignore,
        ),
      ),
      Effect.forkIn(backgroundScope),
      Effect.asVoid,
    );

  /** The commit a new worktree starts from: origin's copy of `baseRef` when asked and present. */
  const resolveStartRef = Effect.fn("WorkspaceService.resolveStartRef")(function* (
    workspaceId: WorkspaceId,
    root: string,
    baseRef: string,
    startFromOrigin: boolean,
  ) {
    if (!startFromOrigin) return baseRef;
    const hasOrigin = yield* git
      .remoteExists({ cwd: root, remoteName: "origin" })
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasOrigin) return baseRef;
    appendLog(workspaceId, `Fetching origin/${baseRef}…\n`);
    yield* git
      .fetchRemote({ cwd: root, remoteName: "origin", refName: baseRef })
      .pipe(
        Effect.catch((error) => Effect.sync(() => appendLog(workspaceId, `${describe(error)}\n`))),
      );
    const remoteBase = yield* git
      .remoteBranchExists({ cwd: root, remoteName: "origin", refName: baseRef })
      .pipe(Effect.orElseSucceed(() => false));
    if (!remoteBase) return baseRef;
    return yield* git
      .resolveRemoteTrackingCommit({ cwd: root, refName: baseRef, fallbackRemoteName: "origin" })
      .pipe(
        Effect.map((resolved) => resolved.commitSha),
        Effect.orElseSucceed(() => baseRef),
      );
  });

  /** Checks out an existing branch, tracking origin's copy when there is no local one. */
  const checkoutExistingBranch = Effect.fn("WorkspaceService.checkoutExistingBranch")(function* (
    workspaceId: WorkspaceId,
    root: string,
    branch: string,
    worktreePath: string,
  ) {
    let branches = yield* listBranchNames(root);
    if (!branches.has(branch)) {
      appendLog(workspaceId, `Fetching origin/${branch}…\n`);
      yield* git
        .fetchRemote({ cwd: root, remoteName: "origin", refName: branch })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => appendLog(workspaceId, `${describe(error)}\n`)),
          ),
        );
      branches = yield* listBranchNames(root);
    }
    appendLog(workspaceId, `Creating worktree ${worktreePath} on ${branch}…\n`);
    if (branches.has(branch)) {
      return yield* git
        .createWorktree({ cwd: root, refName: branch, path: worktreePath })
        .pipe(Effect.mapError(gitFailure("Could not create the worktree")));
    }
    if (!branches.has(`origin/${branch}`)) {
      return yield* workspaceError("git-failed", `The branch ${branch} no longer exists.`);
    }
    // Starting from a remote-tracking ref makes git set it as the upstream.
    return yield* git
      .createWorktree({
        cwd: root,
        refName: `origin/${branch}`,
        newRefName: branch,
        path: worktreePath,
      })
      .pipe(Effect.mapError(gitFailure("Could not create the worktree")));
  });

  const provision = Effect.fn("WorkspaceService.provision")(function* (workspaceId: WorkspaceId) {
    const { workspace } = yield* get(workspaceId);
    const project = yield* loadProject(workspace.projectId);
    const root = project.workspaceRoot;
    if (!(yield* exists(workspace.worktreePath))) {
      const baseRef = workspace.baseRef ?? (yield* resolveDefaultBranch(root));
      const checkout = workspace.checkout;
      let branch = workspace.branch;
      if (checkout.type === "branch" && branch !== null) {
        yield* checkoutExistingBranch(workspaceId, root, branch, workspace.worktreePath);
      } else if (checkout.type === "pullRequest") {
        // Detached first, so upstream's single-checkout PR flow can run inside it.
        const startRef = yield* resolveStartRef(workspaceId, root, baseRef, true);
        // A commit, not a branch name: the branch may be checked out in the main folder.
        const startCommit = yield* runGit(root, ["rev-parse", "--verify", `${startRef}^{commit}`]);
        appendLog(workspaceId, `Creating worktree ${workspace.worktreePath}…\n`);
        yield* git
          .createWorktree({
            cwd: root,
            refName: startCommit.ok ? startCommit.stdout : startRef,
            path: workspace.worktreePath,
          })
          .pipe(Effect.mapError(gitFailure("Could not create the worktree")));
        appendLog(workspaceId, `Checking out pull request #${checkout.number}…\n`);
        const prepared = yield* git
          .preparePullRequestThread({
            cwd: workspace.worktreePath,
            reference: String(checkout.number),
            mode: "local",
          })
          .pipe(Effect.mapError(gitFailure("Could not check out the pull request")));
        branch = prepared.branch;
      } else {
        branch = branch ?? workspace.name;
        const startRef = yield* resolveStartRef(
          workspaceId,
          root,
          baseRef,
          checkout.type === "new" ? checkout.startFromOrigin : true,
        );
        appendLog(workspaceId, `Creating worktree ${workspace.worktreePath} on ${branch}…\n`);
        const branchExists = (yield* listBranchNames(root)).has(branch);
        yield* git
          .createWorktree({
            cwd: root,
            refName: branchExists ? branch : startRef,
            ...(branchExists ? {} : { newRefName: branch, baseRefName: baseRef }),
            path: workspace.worktreePath,
          })
          .pipe(Effect.mapError(gitFailure("Could not create the worktree")));
      }
      yield* update(workspaceId, (record) => ({
        ...record,
        workspace: { ...record.workspace, baseRef, branch },
      }));
      // A pull request's branch is known only now; the first chat started without one.
      const firstChat = workspace.setupTerminal?.threadId;
      if (checkout.type === "pullRequest" && branch !== null && firstChat !== undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`fork-workspace-branch:${workspaceId}`),
            threadId: firstChat,
            branch,
          })
          .pipe(Effect.ignore);
      }
    }
    yield* recordRealPath(workspace);
    yield* setStatus(workspaceId, "ready", { pendingOperation: null, error: null });
    const setupOk = yield* runScript(workspaceId, "setup");
    // Chats' first turns wait on this (`forkWorkspaceSetupSettled`), so they run after setup.
    yield* update(workspaceId, (record) => ({
      ...record,
      workspace: {
        ...record.workspace,
        setupPending: false,
        ...(setupOk ? {} : { error: "The setup script failed. Chats still work." }),
      },
    }));
  });

  /** The folder that has `branch` checked out, if any; git refuses a second checkout. */
  const checkedOutAt = (root: string, branch: string) =>
    runGit(root, ["worktree", "list", "--porcelain"]).pipe(
      Effect.map((result) => {
        let current: string | null = null;
        for (const line of result.ok ? result.stdout.split("\n") : []) {
          if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
          if (line === `branch refs/heads/${branch}`) return current;
        }
        return null;
      }),
    );

  /** The local branch a pull request checks out on; null when gh cannot say. */
  const pullRequestBranch = Effect.fn("WorkspaceService.pullRequestBranch")(function* (
    projectId: ProjectId,
    root: string,
    number: number,
  ) {
    const output = yield* runGh(projectId, [
      "pr",
      "view",
      String(number),
      "--json",
      "headRefName,isCrossRepository",
    ]).pipe(Effect.option);
    const head = Option.flatMap(output, decodeGhPullRequestHead);
    if (Option.isNone(head)) return null;
    const { headRefName, isCrossRepository } = head.value;
    // A fork's default branch checks out under its owner's name, so it cannot collide.
    if (isCrossRepository && headRefName === (yield* resolveDefaultBranch(root))) return null;
    return headRefName;
  });

  /** The composer's prompt, held in the preparing run until setup finishes, no client needed. */
  const startFirstChat = Effect.fn("WorkspaceService.startFirstChat")(function* (
    workspace: Workspace,
    threadId: ThreadId,
    message: WorkspaceFirstMessage,
  ) {
    yield* threadLaunch.launch({
      commandId: CommandId.make(`fork-workspace-first-chat:${workspace.id}`),
      threadId,
      projectId: workspace.projectId,
      title: message.title,
      generateTitle: true,
      modelSelection: message.modelSelection,
      runtimeMode: message.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: workspace.worktreePath,
        ...(workspace.branch === null ? {} : { branch: workspace.branch }),
      },
      initialMessage: {
        text: message.text,
        attachments: [],
        ...(message.context === undefined ? {} : { context: message.context }),
      },
      createdBy: "user",
      creationSource: "web",
    });
  });

  const create: WorkspaceService["Service"]["create"] = ({
    projectId,
    setupThreadId,
    baseRef,
    checkout,
    firstMessage,
  }) =>
    createLock.withPermits(1)(
      Effect.gen(function* () {
        const project = yield* loadProject(projectId);
        const branchToCheckOut =
          checkout?.type === "branch"
            ? checkout.branch
            : checkout?.type === "pullRequest"
              ? yield* pullRequestBranch(projectId, project.workspaceRoot, checkout.number)
              : null;
        if (branchToCheckOut !== null) {
          const holder = yield* checkedOutAt(project.workspaceRoot, branchToCheckOut);
          if (holder !== null) {
            return yield* workspaceError(
              "invalid-state",
              `${branchToCheckOut} is already checked out at ${holder}.`,
            );
          }
        }
        const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
        // The folder keeps the bare city; the branch follows the user's naming prefix.
        const branchFor = (city: string) =>
          settings === null
            ? city
            : formatGeneratedBranchName(city, {
                mode: "static",
                prefix: resolveProjectSettings(settings, projectId).settings.branchNamePrefix,
                instructions: "",
              });
        const parent = yield* worktreeParent(project.workspaceRoot);
        const branches = yield* listBranchNames(project.workspaceRoot);
        const folders = new Set(
          yield* fileSystem.readDirectory(parent).pipe(Effect.orElseSucceed(() => [])),
        );
        const usedNames = new Set(
          snapshot()
            .filter((workspace) => workspace.projectId === projectId)
            .map((workspace) => workspace.name),
        );
        const name = pickCityName(
          (candidate) =>
            usedNames.has(candidate) ||
            branches.has(branchFor(candidate)) ||
            branches.has(`origin/${branchFor(candidate)}`) ||
            folders.has(candidate),
        );
        const workspace: Workspace = {
          id: WorkspaceId.make(yield* newId),
          projectId,
          name,
          worktreePath: path.join(parent, name),
          branch:
            checkout?.type === "branch"
              ? checkout.branch
              : checkout?.type === "pullRequest"
                ? null
                : branchFor(name),
          baseRef: baseRef ?? null,
          status: "creating",
          pendingOperation: "create",
          error: null,
          lastScript: null,
          setupTerminal:
            setupThreadId === undefined
              ? null
              : { threadId: setupThreadId, terminalId: WORKSPACE_SETUP_TERMINAL_ID },
          runningScripts: [],
          setupPending: true,
          checkout:
            checkout === undefined
              ? { type: "new", startFromOrigin: true }
              : checkout.type === "branch"
                ? { type: "branch" }
                : checkout,
          createdAt: yield* nowIso,
          archivedAt: null,
          lastTurnAt: null,
          behindBy: null,
        };
        yield* put({ workspace, archivedThreadIds: [], log: "" });
        yield* fork(workspace.id, "Creating the workspace", provision(workspace.id));
        if (firstMessage !== undefined && setupThreadId !== undefined) {
          // The workspace exists either way; without the chat, the client keeps the prompt.
          yield* startFirstChat(workspace, setupThreadId, firstMessage).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workspace first chat not started", {
                workspaceId: workspace.id,
                cause,
              }),
            ),
          );
        }
        return workspace;
      }),
    );

  const waitForThreadCleanup = Effect.fn("WorkspaceService.waitForThreadCleanup")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return;
    const pending = sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_effect_outbox
        WHERE thread_id IN ${sql.in(threadIds)} AND status IN ('pending', 'running')
        LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));
    // The archive dispatch only queues session detach and terminal cleanup;
    // the folder must outlive them.
    yield* pending.pipe(
      Effect.repeat({ while: (busy) => busy, schedule: Schedule.spaced("250 millis") }),
      Effect.timeoutOrElse({
        duration: OUTBOX_DRAIN_TIMEOUT,
        orElse: () =>
          Effect.fail(
            workspaceError("invalid-state", "The workspace's chats are still shutting down."),
          ),
      }),
      Effect.mapError((cause) =>
        isWorkspaceError(cause) ? cause : workspaceError("persistence-failed", describe(cause)),
      ),
    );
  });

  const teardown = Effect.fn("WorkspaceService.teardown")(function* (
    workspaceId: WorkspaceId,
    ignoreScriptFailure: boolean,
  ) {
    const scriptOk = yield* runScript(workspaceId, "archive");
    if (!scriptOk && !ignoreScriptFailure) {
      yield* setStatus(workspaceId, "ready", {
        pendingOperation: null,
        error: "The archive script failed. Fix it, or archive anyway.",
      });
      return;
    }
    const { workspace } = yield* get(workspaceId);
    const members = (yield* memberThreads(workspace)).filter(
      (thread) => thread.archivedAt === undefined || thread.archivedAt === null,
    );
    const archivedIds: Array<ThreadId> = [];
    for (const thread of members) {
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`fork-workspace-archive:${yield* newId}`),
          threadId: thread.id,
        })
        .pipe(
          Effect.mapError(() =>
            workspaceError("invalid-state", `Could not archive "${thread.title}".`),
          ),
        );
      archivedIds.push(thread.id);
      yield* terminals.close({ threadId: thread.id }).pipe(Effect.ignore);
    }
    yield* update(workspaceId, (record) => ({
      ...record,
      archivedThreadIds: [...new Set([...record.archivedThreadIds, ...archivedIds])],
    }));
    yield* waitForThreadCleanup(archivedIds);
    if ((yield* memberThreads(workspace)).some(isBusy)) {
      return yield* workspaceError("agents-running", "An agent started while archiving.");
    }
    const project = yield* loadProject(workspace.projectId);
    if (yield* exists(workspace.worktreePath)) {
      appendLog(workspaceId, `Removing ${workspace.worktreePath}…\n`);
      yield* withWorkspaceLease(
        workspace.worktreePath,
        git.removeWorktree({
          cwd: project.workspaceRoot,
          path: workspace.worktreePath,
          force: true,
        }),
      ).pipe(Effect.mapError(gitFailure("Could not remove the worktree")));
    }
    yield* terminals.close({ threadId: workspaceTerminalThread(workspaceId) }).pipe(Effect.ignore);
    appendLog(workspaceId, "Archived. The branch was kept.\n");
    yield* setStatus(workspaceId, "archived", {
      pendingOperation: null,
      error: null,
      archivedAt: yield* nowIso,
    });
  });

  const archive: WorkspaceService["Service"]["archive"] = (input) =>
    locked(
      input.workspaceId,
      Effect.gen(function* () {
        const { workspace } = yield* get(input.workspaceId);
        if (workspace.status === "archived" || workspace.status === "archiving") {
          return yield* workspaceError("invalid-state", "This workspace is already archived.");
        }
        if (workspace.status === "creating") {
          return yield* workspaceError(
            "invalid-state",
            "Wait for the workspace to finish creating.",
          );
        }
        if ((yield* memberThreads(workspace)).some(isBusy)) {
          return yield* workspaceError(
            "agents-running",
            "Stop the agents in this workspace first.",
          );
        }
        const folderExists = yield* exists(workspace.worktreePath);
        if (folderExists && input.discardChanges !== true) {
          const changed = yield* changedFiles(workspace.worktreePath);
          if (changed.length > 0) {
            return yield* new WorkspaceError({
              reason: "uncommitted-changes",
              message: `${changed.length} uncommitted file${changed.length === 1 ? "" : "s"} would be lost.`,
              changedFiles: changed.slice(0, 50),
            });
          }
        }
        // The branch may have been renamed or switched since creation.
        const head = folderExists
          ? yield* runGit(workspace.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
          : { ok: false, stdout: "" };
        const sha =
          head.ok && head.stdout === "HEAD"
            ? yield* runGit(workspace.worktreePath, ["rev-parse", "HEAD"])
            : null;
        const branch = head.ok
          ? head.stdout === "HEAD"
            ? sha?.ok
              ? sha.stdout
              : workspace.branch
            : head.stdout
          : workspace.branch;
        return yield* setStatus(input.workspaceId, "archiving", {
          pendingOperation: "archive",
          error: null,
          branch,
        });
      }),
    ).pipe(
      Effect.tap(() =>
        fork(
          input.workspaceId,
          "Archiving the workspace",
          teardown(input.workspaceId, input.ignoreScriptFailure === true),
        ),
      ),
    );

  const restore = Effect.fn("WorkspaceService.restore")(function* (workspaceId: WorkspaceId) {
    const { workspace, archivedThreadIds } = yield* get(workspaceId);
    const project = yield* loadProject(workspace.projectId);
    // Upstream may have recreated the folder when a chat was resumed directly.
    if (!(yield* exists(workspace.worktreePath))) {
      const ref = workspace.branch ?? workspace.name;
      appendLog(workspaceId, `Restoring ${workspace.worktreePath} from ${ref}…\n`);
      yield* git
        .createWorktree({
          cwd: project.workspaceRoot,
          refName: ref,
          path: workspace.worktreePath,
        })
        .pipe(Effect.mapError(gitFailure("Could not restore the worktree")));
    }
    const stillArchived: Array<ThreadId> = [];
    for (const threadId of archivedThreadIds) {
      const commandId = CommandId.make(`fork-workspace-unarchive:${yield* newId}`);
      yield* threads
        .dispatch({ type: "thread.unarchive", commandId, threadId })
        .pipe(Effect.catch(() => Effect.sync(() => stillArchived.push(threadId))));
    }
    yield* recordRealPath(workspace);
    // Unreopened chats stay listed so Restore on a later retry still finds them.
    yield* update(workspaceId, (record) => ({
      ...record,
      archivedThreadIds: stillArchived,
      workspace: {
        ...record.workspace,
        setupTerminal:
          archivedThreadIds[0] === undefined
            ? record.workspace.setupTerminal
            : { threadId: archivedThreadIds[0], terminalId: WORKSPACE_SETUP_TERMINAL_ID },
        status: "ready",
        pendingOperation: null,
        error:
          stillArchived.length === 0
            ? null
            : `${stillArchived.length} chat${stillArchived.length === 1 ? "" : "s"} could not be reopened.`,
        archivedAt: null,
      },
    }));
    const setupOk = yield* runScript(workspaceId, "setup");
    if (!setupOk) {
      yield* update(workspaceId, (record) => ({
        ...record,
        workspace: { ...record.workspace, error: "The setup script failed. Chats still work." },
      }));
    }
  });

  const unarchive: WorkspaceService["Service"]["unarchive"] = (workspaceId) =>
    locked(
      workspaceId,
      Effect.gen(function* () {
        const { workspace } = yield* get(workspaceId);
        if (workspace.status !== "archived" && workspace.pendingOperation !== "unarchive") {
          return yield* workspaceError("invalid-state", "This workspace is not archived.");
        }
        return yield* setStatus(workspaceId, "creating", {
          pendingOperation: "unarchive",
          error: null,
        });
      }),
    ).pipe(Effect.tap(() => fork(workspaceId, "Restoring the workspace", restore(workspaceId))));

  const retry: WorkspaceService["Service"]["retry"] = Effect.fn("WorkspaceService.retry")(
    function* (workspaceId: WorkspaceId) {
      const { workspace } = yield* get(workspaceId);
      switch (workspace.pendingOperation) {
        case "create": {
          const updated = yield* locked(
            workspaceId,
            setStatus(workspaceId, "creating", { error: null }),
          );
          yield* fork(workspaceId, "Creating the workspace", provision(workspaceId));
          return updated;
        }
        case "archive":
          return yield* archive({ workspaceId });
        case "unarchive":
          return yield* unarchive(workspaceId);
        case null:
          return yield* workspaceError("invalid-state", "Nothing to retry.");
      }
    },
  );

  const stream: WorkspaceService["Service"]["stream"] = Stream.callback<WorkspaceStateEvent>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, state());
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((workspaces) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, workspaces)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  const runGh = Effect.fn("WorkspaceService.runGh")(function* (
    projectId: ProjectId,
    args: ReadonlyArray<string>,
  ) {
    const project = yield* loadProject(projectId);
    const output = yield* processRunner
      .run({ command: "gh", args, cwd: project.workspaceRoot, timeout: "20 seconds" })
      .pipe(
        Effect.mapError(() =>
          workspaceError(
            "github-cli-unavailable",
            "This needs the GitHub CLI. Install gh, then run `gh auth login`.",
          ),
        ),
      );
    if (output.code !== 0) {
      const reason = output.stderr.trim().split("\n")[0] ?? "";
      return yield* workspaceError(
        "github-cli-unavailable",
        reason.length > 0 ? reason : "The GitHub CLI failed.",
      );
    }
    return output.stdout;
  });

  const unreadableGhOutput = () =>
    workspaceError(
      "github-cli-unavailable",
      "The GitHub CLI returned output T3 Code could not read.",
    );

  const listIssues: WorkspaceService["Service"]["listIssues"] = Effect.fn(
    "WorkspaceService.listIssues",
  )(function* ({ projectId, query }) {
    const stdout = yield* runGh(projectId, [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(GH_LIST_LIMIT),
      "--json",
      "number,title,url",
      ...(query === undefined ? [] : ["--search", query]),
    ]);
    return yield* decodeIssues(stdout).pipe(Effect.mapError(unreadableGhOutput));
  });

  const listPullRequests: WorkspaceService["Service"]["listPullRequests"] = Effect.fn(
    "WorkspaceService.listPullRequests",
  )(function* ({ projectId, query }) {
    const stdout = yield* runGh(projectId, [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(GH_LIST_LIMIT),
      "--json",
      "number,title,url,headRefName,baseRefName,isDraft",
      ...(query === undefined ? [] : ["--search", query]),
    ]);
    const pullRequests = yield* decodeGhPullRequests(stdout).pipe(
      Effect.mapError(unreadableGhOutput),
    );
    return pullRequests.map(({ headRefName, baseRefName, ...rest }) => ({
      ...rest,
      headBranch: headRefName,
      baseBranch: baseRefName,
    }));
  });

  const readIssue: WorkspaceService["Service"]["readIssue"] = Effect.fn(
    "WorkspaceService.readIssue",
  )(function* ({ projectId, number }) {
    const stdout = yield* runGh(projectId, [
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,url,body",
    ]);
    const issue = yield* decodeIssue(stdout).pipe(Effect.mapError(unreadableGhOutput));
    const body = issue.body ?? "";
    return body.length > ISSUE_BODY_MAX_CHARS
      ? { ...issue, body: `${body.slice(0, ISSUE_BODY_MAX_CHARS)}\n\n[Truncated]` }
      : issue;
  });

  const setProjectScripts: WorkspaceService["Service"]["setProjectScripts"] = Effect.fn(
    "WorkspaceService.setProjectScripts",
  )(function* (scripts: ProjectWorkspaceScripts) {
    yield* store.saveProjectScripts(scripts);
    projectScripts.set(scripts.projectId, scripts);
    yield* PubSub.publish(changes, state());
    return scripts;
  });

  const setRunning = (
    workspaceId: WorkspaceId,
    change: (
      running: ReadonlyArray<WorkspaceRunningScript>,
    ) => ReadonlyArray<WorkspaceRunningScript>,
  ) =>
    update(workspaceId, (record) => ({
      ...record,
      workspace: { ...record.workspace, runningScripts: change(record.workspace.runningScripts) },
    })).pipe(Effect.ignore);

  const runProjectScript: WorkspaceService["Service"]["runProjectScript"] = Effect.fn(
    "WorkspaceService.runProjectScript",
  )(function* (input: WorkspaceRunScriptInput) {
    const { workspace } = yield* get(input.workspaceId);
    if (workspace.status !== "ready" && workspace.status !== "failed") {
      return yield* workspaceError("invalid-state", "Scripts run once the workspace is ready.");
    }
    const script = projectScripts
      .get(workspace.projectId)
      ?.scripts.find((entry) => entry.id === input.scriptId);
    if (script === undefined || script.command.trim().length === 0) {
      return yield* workspaceError("not-found", "This script no longer exists.");
    }
    // Its terminal is still busy; the client just shows it again.
    if (workspace.runningScripts.some((entry) => entry.scriptId === script.id)) return workspace;
    const project = yield* loadProject(workspace.projectId);
    const running: WorkspaceRunningScript = {
      scriptId: script.id,
      name: script.name.trim() || "script",
      threadId: input.threadId,
      terminalId: workspaceScriptTerminalId(script.id),
    };
    yield* runWorkspaceScript({
      threadId: running.threadId,
      terminalId: running.terminalId,
      command: script.command,
      cwd: workspace.worktreePath,
      env: scriptEnv(workspace, project.workspaceRoot),
      onOutput: (text) => appendLog(workspace.id, text),
      onOpened: setRunning(workspace.id, (current) => [...current, running]),
    }).pipe(
      Effect.provideService(TerminalManager.TerminalManager, terminals),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      // Ctrl+C or closing the terminal also ends the run.
      Effect.ensuring(
        setRunning(workspace.id, (current) =>
          current.filter((entry) => entry.scriptId !== running.scriptId),
        ),
      ),
      Effect.forkIn(backgroundScope),
    );
    return workspace;
  });

  const logStream: WorkspaceService["Service"]["logStream"] = (workspaceId) =>
    Stream.callback<WorkspaceLogEvent>((mailbox) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (event: WorkspaceLogEvent) => {
            Queue.offerUnsafe(mailbox, event);
          };
          let listeners = logListeners.get(workspaceId);
          if (!listeners) {
            listeners = new Set();
            logListeners.set(workspaceId, listeners);
          }
          listeners.add(listener);
          Queue.offerUnsafe(mailbox, {
            type: "snapshot",
            text: records.get(workspaceId)?.log ?? "",
          });
          return listener;
        }),
        (listener) => Effect.sync(() => logListeners.get(workspaceId)?.delete(listener)),
      ),
    );

  for (const scripts of yield* store.listProjectScripts.pipe(Effect.orElseSucceed(() => []))) {
    projectScripts.set(scripts.projectId, scripts);
  }
  const startedAt = yield* nowIso;
  for (const record of yield* store.list.pipe(Effect.orElseSucceed(() => []))) {
    // Script terminals do not survive a restart.
    let workspace: Workspace =
      record.workspace.runningScripts.length === 0
        ? record.workspace
        : { ...record.workspace, runningScripts: [] };
    const folderExists = yield* exists(workspace.worktreePath);
    // Nothing runs across a restart; leave an explicit retry instead of a lying spinner.
    if (workspace.status === "creating" || workspace.status === "archiving") {
      workspace =
        workspace.status === "archiving" && !folderExists
          ? { ...workspace, status: "archived", pendingOperation: null, archivedAt: startedAt }
          : { ...workspace, status: "failed", error: "Interrupted by a server restart." };
    }
    if (workspace.lastScript?.phase === "running") {
      workspace = {
        ...workspace,
        lastScript: { ...workspace.lastScript, phase: "failed", endedAt: startedAt },
      };
    }
    if (workspace.setupPending) workspace = { ...workspace, setupPending: false };
    records.set(workspace.id, { ...record, workspace });
    syncOwnership(workspace);
    if (folderExists) yield* recordRealPath(workspace);
    if (workspace !== record.workspace) {
      yield* store.save({ ...record, workspace }).pipe(Effect.ignore);
    }
  }

  // Chats that ran before turns were remembered on the workspace, archived ones included.
  if (
    Array.from(records.values()).some(
      ({ workspace }) => workspace.status !== "archived" && workspace.lastTurnAt === null,
    )
  ) {
    const shells = yield* Effect.forEach(["active", "archive"] as const, (location) =>
      threads.getShellSnapshot({ location }).pipe(
        Effect.map((snapshot) => snapshot.threads),
        Effect.orElseSucceed(() => []),
      ),
    ).pipe(Effect.map((locations) => locations.flat()));
    for (const record of records.values()) {
      const { workspace } = record;
      if (workspace.status === "archived" || workspace.lastTurnAt !== null) continue;
      const lastTurnAt = shells
        .filter((shell) => isWorkspaceChat(workspace, shell))
        .map((shell) => shell.latestRunCompletedAt ?? shell.latestRunRequestedAt)
        .filter((at) => at != null)
        .map(DateTime.formatIso)
        .reduce<string | null>(
          (latest, at) => (latest === null || at > latest ? at : latest),
          null,
        );
      if (lastTurnAt === null) continue;
      const next = { ...record, workspace: { ...workspace, lastTurnAt } };
      records.set(workspace.id, next);
      yield* store.save(next).pipe(Effect.ignore);
    }
  }

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type === "thread.metadata-updated") {
        return followBranchRename(event.payload).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workspace branch tracking skipped", {
              threadId: event.threadId,
              cause,
            }),
          ),
        );
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return Effect.void;
      const { requestedAt, completedAt } = event.payload;
      // A start counts when the run is created, an end once it completes; nothing in between.
      if (event.type === "run.updated" && completedAt === null) return Effect.void;
      return recordTurn(event.threadId, DateTime.formatIso(completedAt ?? requestedAt)).pipe(
        Effect.andThen(
          completedAt === null
            ? Effect.void
            : nameBranchAfterTurn(event.threadId).pipe(
                // An agent may have merged or committed; recount from the refs at hand.
                Effect.andThen(refreshBehindForThread(event.threadId)),
                Effect.forkIn(backgroundScope),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace turn tracking skipped", { threadId: event.threadId, cause }),
        ),
      );
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("workspace turn tracking stream failed", { cause }),
    ),
    Effect.forkIn(backgroundScope),
  );

  const stopTerminalTracking = yield* terminals.subscribeMetadata(onTerminalMetadata);
  yield* Effect.addFinalizer(() => Effect.sync(stopTerminalTracking));

  yield* refreshAllBehind.pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.catchCause((cause) => Effect.logWarning("workspace behind counts stopped", { cause })),
    Effect.forkIn(backgroundScope),
  );

  return WorkspaceService.of({
    updateFromBase: updateFromBaseNow,
    autoUpdateFromBase,
    runProjectScript,
    setProjectScripts,
    listIssues,
    listPullRequests,
    readIssue,
    create,
    archive,
    unarchive,
    retry,
    list,
    stream,
    logStream,
  });
});

export const layer = Layer.effect(WorkspaceService, make);
