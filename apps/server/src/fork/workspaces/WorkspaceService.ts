import {
  CommandId,
  normalizeWorkspacePath,
  WorkspaceError,
  WorkspaceId,
  WorkspaceProjectFileConfig,
  type ProjectId,
  type ThreadId,
  type Workspace,
  type WorkspaceArchiveInput,
  type WorkspaceCreateInput,
  type ProjectWorkspaceScripts,
  type WorkspaceRunScriptInput,
  type WorkspaceRunningScript,
  type WorkspaceStateEvent,
  type WorkspaceLogEvent,
  type WorkspaceScriptKind,
  type WorkspaceStatus,
} from "@t3tools/contracts";
import { formatGeneratedBranchName } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
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
  }
>()("t3/fork/workspaces/WorkspaceService") {}

const OUTBOX_DRAIN_TIMEOUT = Duration.seconds(30);
const SETUP_TERMINAL_ID = "workspace-setup";
const ARCHIVE_TERMINAL_ID = "workspace-archive";
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

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isWorkspaceError = Schema.is(WorkspaceError);

export const make = Effect.gen(function* () {
  const store = yield* WorkspaceStore;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const terminals = yield* TerminalManager.TerminalManager;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const ownership = yield* WorkspaceOwnership;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
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
      { workspaceId: workspace.id, status: workspace.status },
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

  const update = (workspaceId: WorkspaceId, change: (record: StoredWorkspace) => StoredWorkspace) =>
    Effect.flatMap(get(workspaceId), (record) => put(change(record)));

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
            terminalId: kind === "setup" ? SETUP_TERMINAL_ID : ARCHIVE_TERMINAL_ID,
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
      Effect.provideService(Crypto.Crypto, crypto),
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
    threads.listProjectThreads({ projectId: workspace.projectId, includeSubagents: true }).pipe(
      Effect.map((shells) =>
        shells.filter((shell) => samePath(shell.worktreePath, workspace.worktreePath)),
      ),
      Effect.mapError(() =>
        workspaceError("invalid-state", "Could not read the workspace's chats."),
      ),
    );

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

  const provision = Effect.fn("WorkspaceService.provision")(function* (workspaceId: WorkspaceId) {
    const { workspace } = yield* get(workspaceId);
    const project = yield* loadProject(workspace.projectId);
    const root = project.workspaceRoot;
    if (!(yield* exists(workspace.worktreePath))) {
      const baseRef = workspace.baseRef ?? (yield* resolveDefaultBranch(root));
      let startRef = baseRef;
      const hasOrigin = yield* git
        .remoteExists({ cwd: root, remoteName: "origin" })
        .pipe(Effect.orElseSucceed(() => false));
      if (hasOrigin) {
        appendLog(workspaceId, `Fetching origin/${baseRef}…\n`);
        yield* git
          .fetchRemote({ cwd: root, remoteName: "origin", refName: baseRef })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => appendLog(workspaceId, `${describe(error)}\n`)),
            ),
          );
        const remoteBase = yield* git
          .remoteBranchExists({ cwd: root, remoteName: "origin", refName: baseRef })
          .pipe(Effect.orElseSucceed(() => false));
        if (remoteBase) {
          startRef = yield* git
            .resolveRemoteTrackingCommit({
              cwd: root,
              refName: baseRef,
              fallbackRemoteName: "origin",
            })
            .pipe(
              Effect.map((resolved) => resolved.commitSha),
              Effect.orElseSucceed(() => baseRef),
            );
        }
      }
      const branch = workspace.branch ?? workspace.name;
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
      yield* update(workspaceId, (record) => ({
        ...record,
        workspace: { ...record.workspace, baseRef },
      }));
    }
    yield* recordRealPath(workspace);
    yield* setStatus(workspaceId, "ready", { pendingOperation: null, error: null });
    const setupOk = yield* runScript(workspaceId, "setup");
    if (!setupOk) {
      yield* update(workspaceId, (record) => ({
        ...record,
        workspace: { ...record.workspace, error: "The setup script failed. Chats still work." },
      }));
    }
  });

  const create: WorkspaceService["Service"]["create"] = ({ projectId, setupThreadId }) =>
    createLock.withPermits(1)(
      Effect.gen(function* () {
        const project = yield* loadProject(projectId);
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
          branch: branchFor(name),
          baseRef: null,
          status: "creating",
          pendingOperation: "create",
          error: null,
          lastScript: null,
          setupTerminal:
            setupThreadId === undefined
              ? null
              : { threadId: setupThreadId, terminalId: SETUP_TERMINAL_ID },
          runningScripts: [],
          createdAt: yield* nowIso,
          archivedAt: null,
        };
        yield* put({ workspace, archivedThreadIds: [], log: "" });
        yield* fork(workspace.id, "Creating the workspace", provision(workspace.id));
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
            : { threadId: archivedThreadIds[0], terminalId: SETUP_TERMINAL_ID },
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
      terminalId: `script-${script.id}`,
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
      Effect.provideService(Crypto.Crypto, crypto),
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
    records.set(workspace.id, { ...record, workspace });
    syncOwnership(workspace);
    if (folderExists) yield* recordRealPath(workspace);
    if (workspace !== record.workspace) {
      yield* store.save({ ...record, workspace }).pipe(Effect.ignore);
    }
  }

  return WorkspaceService.of({
    runProjectScript,
    setProjectScripts,
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
