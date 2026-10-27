// @effect-diagnostics nodeBuiltinImport:off - the fixture repo is real git on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  WorkspaceId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type Workspace,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { pickCityName } from "./cityNames.ts";
import {
  forkGuardWorktreeRemoval,
  forkWorkspaceAwaitsBranchName,
  forkWorkspaceOwnsPath,
  makeWorkspaceOwnershipRegistry,
  WorkspaceOwnership,
} from "./WorkspaceOwnership.ts";
import * as WorkspaceService from "./WorkspaceService.ts";
import * as WorkspaceStore from "./WorkspaceStore.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("pickCityName", () => {
  it("skips taken names and falls back to a numbered name", () => {
    assert.equal(
      pickCityName((name) => name !== "oslo"),
      "oslo",
    );
    const fallback = pickCityName(
      (name) => !/-\d+$/.test(name) || name.endsWith("-2"),
      () => 0,
    );
    assert.equal(fallback, "abidjan-3");
  });
});

describe("WorkspaceOwnership", () => {
  const owned = WorkspaceId.make("ws-1");

  it.effect("guards a live workspace's folder under either spelling", () =>
    Effect.gen(function* () {
      const registry = makeWorkspaceOwnershipRegistry();
      registry.set(owned, ["/tmp/link/oslo/", "/private/tmp/link/oslo"], {
        workspaceId: owned,
        status: "ready",
        awaitingBranchName: null,
      });
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(WorkspaceOwnership, registry));

      assert.isTrue(yield* run(forkWorkspaceOwnsPath("/private/tmp/link/oslo")));
      assert.isFalse(yield* run(forkWorkspaceOwnsPath("/tmp/link/other")));
      const blocked = yield* run(
        forkGuardWorktreeRemoval({ cwd: "/repo", path: "/tmp/link/oslo" }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(blocked));

      registry.set(owned, ["/tmp/link/oslo"], {
        workspaceId: owned,
        status: "archiving",
        awaitingBranchName: null,
      });
      yield* run(forkGuardWorktreeRemoval({ cwd: "/repo", path: "/tmp/link/oslo" }));
      // The old real-path spelling no longer maps to anything once re-registered.
      assert.isFalse(yield* run(forkWorkspaceOwnsPath("/private/tmp/link/oslo")));
    }),
  );

  it.effect("is empty without the fork layer", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* forkWorkspaceOwnsPath("/nowhere"));
    }),
  );
});

/**
 * Runs what the runner types into the terminal with /bin/sh, so the test
 * exercises the real wrapper and exit-code sentinel.
 */
function fakeTerminals(fixture: Fixture) {
  const listeners = new Set<
    Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
  >();
  const cwdByTerminal = new Map<string, { cwd: string; env: Record<string, string> }>();
  return Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.sync(() => {
        fixture.terminals.push(`${input.threadId}/${input.terminalId}`);
        cwdByTerminal.set(`${input.threadId}/${input.terminalId}`, {
          cwd: input.cwd,
          env: { ...input.env },
        });
        return {} as never;
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const session = cwdByTerminal.get(`${input.threadId}/${input.terminalId}`)!;
            NodeChildProcess.execFile(
              "/bin/sh",
              ["-c", input.data.replaceAll("\r", "\n")],
              { cwd: session.cwd, env: { ...process.env, ...session.env } },
              (_error, stdout) => resolve(stdout),
            );
          }),
      ).pipe(
        Effect.flatMap((data) =>
          Effect.forEach(
            [...listeners],
            (listener) =>
              listener({
                type: "output",
                threadId: input.threadId,
                terminalId: input.terminalId,
                data,
                createdAt: "2026-10-19T00:00:00.000Z",
              } as never),
            { discard: true },
          ),
        ),
      ),
    close: () => Effect.void,
  });
}

interface Fixture {
  readonly root: string;
  readonly projectId: ProjectId;
  threads: Array<{
    id: ThreadId;
    title: string;
    worktreePath: string | null;
    activeRunId: string | null;
    archivedAt: null;
  }>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly terminals: Array<string>;
  /** Shells by thread id; archived ones are only listed in the archive snapshot. */
  readonly shells: Map<string, { readonly shell: unknown; readonly archived: boolean }>;
  /** Queues into `pendingEvents` until the service subscribes, so start-up timing loses nothing. */
  emit: (event: OrchestrationV2DomainEvent) => void;
  readonly pendingEvents: Array<OrchestrationV2DomainEvent>;
}

function makeFixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ws-repo-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  NodeFS.writeFileSync(
    NodePath.join(root, "t3.json"),
    JSON.stringify({
      workspace: {
        setup: 'echo "setup $T3_WORKSPACE_NAME" >> "$T3_ROOT_PATH/setup.log"',
        archive: 'echo archived >> "$T3_ROOT_PATH/archive.log"',
      },
    }),
  );
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "setup.log\narchive.log\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  const pending: Array<OrchestrationV2DomainEvent> = [];
  return {
    root,
    projectId: ProjectId.make("project-1"),
    threads: [],
    dispatched: [],
    terminals: [],
    shells: new Map(),
    emit: (event) => {
      pending.push(event);
    },
    pendingEvents: pending,
  };
}

function servicesLayer(fixture: Fixture) {
  const project = {
    id: fixture.projectId,
    title: "Repo",
    workspaceRoot: fixture.root,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    deletedAt: null,
  };
  return Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome(project),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      remoteExists: () => Effect.succeed(false),
      fetchRemote: () => Effect.void,
      // Stands in for the host checkout: the PR's head lands on its own branch.
      preparePullRequestThread: (input) =>
        Effect.sync(() => {
          const branch = `pr-${input.reference}`;
          git(input.cwd, "checkout", "-b", branch);
          return {
            pullRequest: {
              number: Number(input.reference),
              title: "PR",
              url: "https://example.com/pr",
              baseBranch: "main",
              headBranch: branch,
              state: "open" as const,
            },
            branch,
            worktreePath: null,
            isOnPullRequestHead: true,
          };
        }),
      createWorktree: (input) =>
        Effect.sync(() => {
          const target = input.path!;
          if (input.newRefName) {
            git(input.cwd, "worktree", "add", "-b", input.newRefName, "--", target, input.refName);
          } else {
            git(input.cwd, "worktree", "add", "--", target, input.refName);
          }
          return { worktree: { path: target, refName: input.newRefName ?? input.refName } };
        }),
      removeWorktree: (input) =>
        forkGuardWorktreeRemoval(input).pipe(
          Effect.andThen(
            Effect.sync(() => {
              git(input.cwd, "worktree", "remove", "--force", "--", input.path);
            }),
          ),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      listProjectThreads: () => Effect.sync(() => fixture.threads as never),
      getShellSnapshot: (options) =>
        Effect.sync(
          () =>
            ({
              threads: Array.from(fixture.shells.values())
                .filter((entry) => entry.archived === (options?.location === "archive"))
                .map((entry) => entry.shell),
            }) as never,
        ),
      getThreadShell: (threadId) =>
        Effect.sync(() => (fixture.shells.get(threadId)?.shell ?? null) as never),
      streamDomainEvents: Stream.callback<OrchestrationV2DomainEvent>((mailbox) =>
        Effect.sync(() => {
          for (const event of fixture.pendingEvents.splice(0)) Queue.offerUnsafe(mailbox, event);
          fixture.emit = (event) => {
            Queue.offerUnsafe(mailbox, event);
          };
        }),
      ),
      dispatch: (command) =>
        Effect.sync(() => {
          fixture.dispatched.push(command);
          return { sequence: fixture.dispatched.length, storedEvents: [] };
        }),
    }),
    fakeTerminals(fixture),
    ServerSettings.layerTest({ branchNamePrefix: "fork" }),
    ServerConfig.layerTest(fixture.root, { prefix: "fork-ws-home-" }),
    ProcessRunner.layer,
    NodeCrypto.layer,
  ).pipe(Layer.provideMerge(Sqlite.layerMemory), Layer.provideMerge(NodeServices.layer));
}

const awaitWorkspace = (
  service: WorkspaceService.WorkspaceService["Service"],
  predicate: (workspace: Workspace) => boolean,
) =>
  service.stream.pipe(
    Stream.map((state) => state.workspaces.find(predicate)),
    Stream.filter((workspace) => workspace !== undefined),
    Stream.runHead,
    Effect.map((workspace) => Option.getOrThrow(workspace)!),
  );

const scriptDone = (workspace: Workspace) =>
  workspace.lastScript !== null && workspace.lastScript.phase !== "running";

describe("WorkspaceService", () => {
  it.live("creates, archives, and restores a workspace around its scripts", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;

      const created = yield* service.create({
        projectId: fixture.projectId,
        setupThreadId: ThreadId.make("thread-draft"),
      });
      assert.equal(created.status, "creating");
      assert.isTrue(created.setupPending);
      const ready = yield* awaitWorkspace(
        service,
        (workspace) => workspace.status === "ready" && !workspace.setupPending,
      );
      assert.equal(ready.name, created.name);
      assert.equal(ready.branch, `fork/${ready.name}`);
      assert.deepEqual(fixture.terminals, ["thread-draft/workspace-setup"]);
      assert.equal(NodePath.basename(ready.worktreePath), ready.name);
      assert.equal(ready.lastScript?.phase, "succeeded");
      assert.isTrue(NodeFS.existsSync(ready.worktreePath));
      assert.equal(
        git(ready.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
        `fork/${ready.name}`,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.root, "setup.log"), "utf8"),
        `setup ${ready.name}\n`,
      );

      const member = {
        id: ThreadId.make("thread-member"),
        title: "Member",
        worktreePath: `${ready.worktreePath}/`,
        activeRunId: null,
        archivedAt: null,
      } as const;
      fixture.threads = [
        member,
        { ...member, id: ThreadId.make("thread-other"), worktreePath: fixture.root },
      ];

      fixture.threads[0] = { ...member, activeRunId: "run-1" };
      const busy = yield* service.archive({ workspaceId: ready.id }).pipe(Effect.flip);
      assert.equal(busy.reason, "agents-running");
      fixture.threads[0] = member;

      NodeFS.writeFileSync(NodePath.join(ready.worktreePath, "draft.txt"), "unsaved");
      const dirty = yield* service.archive({ workspaceId: ready.id }).pipe(Effect.flip);
      assert.equal(dirty.reason, "uncommitted-changes");
      assert.deepEqual(dirty.changedFiles, ["?? draft.txt"]);

      // Archiving refreshes the branch, which the user may have renamed.
      git(ready.worktreePath, "branch", "-m", "renamed-branch");
      yield* service.archive({ workspaceId: ready.id, discardChanges: true });
      const archived = yield* awaitWorkspace(
        service,
        (workspace) => workspace.status === "archived",
      );
      assert.equal(archived.branch, "renamed-branch");
      assert.isFalse(NodeFS.existsSync(ready.worktreePath));
      assert.include(git(fixture.root, "branch", "--list", "renamed-branch"), "renamed-branch");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.root, "archive.log"), "utf8"),
        "archived\n",
      );
      assert.deepEqual(
        fixture.dispatched.map(
          (command) => `${command.type}:${"threadId" in command ? command.threadId : ""}`,
        ),
        ["thread.archive:thread-member"],
      );

      fixture.dispatched.length = 0;
      yield* service.unarchive(ready.id);
      const restored = yield* awaitWorkspace(
        service,
        (workspace) =>
          workspace.status === "ready" && workspace.archivedAt === null && scriptDone(workspace),
      );
      assert.equal(restored.worktreePath, ready.worktreePath);
      assert.equal(
        git(restored.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
        "renamed-branch",
      );
      assert.deepEqual(
        fixture.dispatched.map((command) => command.type),
        ["thread.unarchive"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("prefers settings scripts and runs extra scripts in the viewed chat", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      yield* service.setProjectScripts({
        projectId: fixture.projectId,
        setup: 'echo "from settings"',
        archive: "",
        scripts: [{ id: "dev", name: "Dev", command: "sleep 0.5; echo dev-ran" }],
      });
      const created = yield* service.create({
        projectId: fixture.projectId,
        setupThreadId: ThreadId.make("thread-draft"),
      });
      yield* awaitWorkspace(
        service,
        (workspace) => workspace.id === created.id && scriptDone(workspace),
      );
      // Settings beat the t3.json `workspace.setup` key.
      assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, "setup.log")));

      yield* service.runProjectScript({
        workspaceId: created.id,
        scriptId: "dev",
        threadId: ThreadId.make("thread-chat"),
      });
      yield* awaitWorkspace(
        service,
        (workspace) => workspace.id === created.id && workspace.runningScripts.length > 0,
      );
      const finished = yield* awaitWorkspace(
        service,
        (workspace) => workspace.id === created.id && workspace.runningScripts.length === 0,
      );
      assert.deepEqual(finished.runningScripts, []);
      assert.include(fixture.terminals, "thread-chat/script-dev");

      const missing = yield* service
        .runProjectScript({
          workspaceId: created.id,
          scriptId: "nope",
          threadId: ThreadId.make("thread-chat"),
        })
        .pipe(Effect.flip);
      assert.equal(missing.reason, "not-found");
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("keeps an archive open when its script fails", () => {
    const fixture = makeFixture();
    NodeFS.writeFileSync(
      NodePath.join(fixture.root, "t3.json"),
      JSON.stringify({ workspace: { archive: "echo nope; exit 3" } }),
    );
    git(fixture.root, "commit", "-am", "failing archive");
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      const created = yield* service.create({
        projectId: fixture.projectId,
        setupThreadId: ThreadId.make("thread-draft"),
      });
      yield* awaitWorkspace(service, (workspace) => workspace.status === "ready");
      yield* service.archive({ workspaceId: created.id });
      const reopened = yield* awaitWorkspace(
        service,
        (workspace) =>
          workspace.status === "ready" &&
          workspace.lastScript?.kind === "archive" &&
          scriptDone(workspace),
      );
      assert.equal(reopened.lastScript?.exitCode, 3);
      // No setup script: only the archive script ever opened a terminal, never the chat's.
      assert.deepEqual(
        fixture.terminals.filter((terminal) => terminal.endsWith("/workspace-setup")),
        [],
      );
      assert.isNotNull(reopened.error);
      assert.isTrue(NodeFS.existsSync(reopened.worktreePath));

      // Getting past the failed script must not also discard new work.
      NodeFS.writeFileSync(NodePath.join(reopened.worktreePath, "late.txt"), "work");
      const refused = yield* service
        .archive({ workspaceId: created.id, ignoreScriptFailure: true })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "uncommitted-changes");
      yield* service.archive({
        workspaceId: created.id,
        ignoreScriptFailure: true,
        discardChanges: true,
      });
      yield* awaitWorkspace(service, (workspace) => workspace.status === "archived");
      assert.isFalse(NodeFS.existsSync(reopened.worktreePath));
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("starts a new branch from the chosen base", () => {
    const fixture = makeFixture();
    git(fixture.root, "checkout", "-b", "dev");
    NodeFS.writeFileSync(NodePath.join(fixture.root, "dev.txt"), "dev");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "dev");
    git(fixture.root, "checkout", "main");
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      const created = yield* service.create({
        projectId: fixture.projectId,
        baseRef: "dev",
        checkout: { type: "new", startFromOrigin: false },
      });
      const ready = yield* awaitWorkspace(
        service,
        (workspace) => workspace.id === created.id && workspace.status === "ready",
      );
      assert.equal(ready.baseRef, "dev");
      assert.equal(ready.branch, `fork/${ready.name}`);
      assert.isTrue(NodeFS.existsSync(NodePath.join(ready.worktreePath, "dev.txt")));
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("checks out an existing branch instead of creating one", () => {
    const fixture = makeFixture();
    git(fixture.root, "branch", "feature");
    // A branch only origin has, as after a fetch.
    git(fixture.root, "remote", "add", "origin", fixture.root);
    git(fixture.root, "update-ref", "refs/remotes/origin/remote-only", "HEAD");
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      const local = yield* service.create({
        projectId: fixture.projectId,
        checkout: { type: "branch", branch: "feature" },
      });
      assert.equal(local.branch, "feature");
      const remote = yield* service.create({
        projectId: fixture.projectId,
        checkout: { type: "branch", branch: "remote-only" },
      });
      const ready = (id: WorkspaceId) =>
        awaitWorkspace(service, (workspace) => workspace.id === id && workspace.status === "ready");
      const localReady = yield* ready(local.id);
      const remoteReady = yield* ready(remote.id);
      assert.equal(git(localReady.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
      assert.equal(
        git(remoteReady.worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}"),
        "origin/remote-only",
      );
      assert.notInclude(git(fixture.root, "branch", "--list"), "fork/");

      const taken = yield* service
        .create({ projectId: fixture.projectId, checkout: { type: "branch", branch: "main" } })
        .pipe(Effect.flip);
      assert.equal(taken.reason, "invalid-state");
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("checks out a pull request in its own workspace", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      const created = yield* service.create({
        projectId: fixture.projectId,
        baseRef: "main",
        checkout: { type: "pullRequest", number: 42 },
      });
      assert.isNull(created.branch);
      const ready = yield* awaitWorkspace(
        service,
        (workspace) => workspace.id === created.id && workspace.status === "ready",
      );
      assert.equal(ready.branch, "pr-42");
      assert.deepEqual(ready.checkout, { type: "pullRequest", number: 42 });
      assert.equal(git(ready.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "pr-42");
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.live("lists issues and pull requests through the GitHub CLI", () => {
    const fixture = makeFixture();
    // A stand-in gh that answers the two calls the service makes.
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ws-gh-"));
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      [
        "#!/bin/sh",
        'if [ "$1" = "pr" ]; then',
        `  echo '[{"number":9,"title":"Fix crash","url":"https://example.com/9","headRefName":"fix","baseRefName":"main","isDraft":true}]'`,
        'elif [ "$2" = "list" ]; then',
        `  echo '[{"number":7,"title":"Crash on start","url":"https://example.com/7"}]'`,
        'elif [ "$3" = "404" ]; then',
        "  echo 'issue not found' >&2; exit 1",
        "else",
        `  echo '{"number":7,"title":"Crash on start","url":"https://example.com/7","body":"Steps"}'`,
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${NodePath.delimiter}${previousPath ?? ""}`;
    return Effect.gen(function* () {
      const service = yield* WorkspaceService.make;
      const issues = yield* service.listIssues({ projectId: fixture.projectId, query: "crash" });
      assert.deepEqual(issues, [
        { number: 7, title: "Crash on start", url: "https://example.com/7" },
      ]);
      const pullRequests = yield* service.listPullRequests({ projectId: fixture.projectId });
      assert.deepEqual(pullRequests, [
        {
          number: 9,
          title: "Fix crash",
          url: "https://example.com/9",
          headBranch: "fix",
          baseBranch: "main",
          isDraft: true,
        },
      ]);
      const issue = yield* service.readIssue({ projectId: fixture.projectId, number: 7 });
      assert.equal(issue.body, "Steps");
      const missing = yield* service
        .readIssue({ projectId: fixture.projectId, number: 404 })
        .pipe(Effect.flip);
      assert.equal(missing.reason, "github-cli-unavailable");
      assert.equal(missing.message, "issue not found");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.env.PATH = previousPath;
        }),
      ),
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.effect("turns operations a restart interrupted into explicit retries", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const store = yield* WorkspaceStore.WorkspaceStore;
      const base: Workspace = {
        id: WorkspaceId.make("ws-creating"),
        projectId: fixture.projectId,
        name: "oslo",
        worktreePath: NodePath.join(fixture.root, "missing-oslo"),
        branch: "oslo",
        baseRef: "main",
        status: "creating",
        pendingOperation: "create",
        error: null,
        lastScript: null,
        setupTerminal: null,
        runningScripts: [],
        setupPending: true,
        checkout: { type: "new", startFromOrigin: true },
        createdAt: "2026-10-19T00:00:00.000Z",
        archivedAt: null,
        lastTurnAt: null,
      };
      yield* store.save({ workspace: base, archivedThreadIds: [], log: "" });
      yield* store.save({
        workspace: {
          ...base,
          id: WorkspaceId.make("ws-archiving"),
          status: "archiving",
          pendingOperation: "archive",
        },
        archivedThreadIds: [],
        log: "",
      });

      const service = yield* WorkspaceService.make;
      const workspaces = yield* service.list;
      const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      assert.equal(byId.get(WorkspaceId.make("ws-creating"))?.status, "failed");
      assert.equal(byId.get(WorkspaceId.make("ws-creating"))?.pendingOperation, "create");
      // Its folder is already gone, so the archive had finished.
      assert.equal(byId.get(WorkspaceId.make("ws-archiving"))?.status, "archived");
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.effect("remembers its chats' latest turn start or end, archived chats included", () => {
    const fixture = makeFixture();
    const worktreePath = NodePath.join(fixture.root, "oslo");
    const at = (hour: number) => `2026-10-19T0${hour}:00:00.000Z`;
    const shell = (
      id: string,
      completedHour: number | null,
      options: { readonly subagent?: boolean; readonly archived?: boolean } = {},
    ) =>
      fixture.shells.set(id, {
        archived: options.archived ?? false,
        shell: {
          id,
          projectId: fixture.projectId,
          worktreePath: `${worktreePath}/`,
          lineage: {
            parentThreadId: options.subagent ? "chat-live" : null,
            relationshipToParent: options.subagent ? "subagent" : null,
          },
          latestRunRequestedAt: null,
          latestRunCompletedAt:
            completedHour === null ? null : DateTime.makeUnsafe(at(completedHour)),
        },
      });
    const run = (
      type: "run.created" | "run.updated",
      threadId: string,
      requestedHour: number,
      completedHour: number | null,
    ) =>
      fixture.emit({
        type,
        threadId: ThreadId.make(threadId),
        payload: {
          requestedAt: DateTime.makeUnsafe(at(requestedHour)),
          completedAt: completedHour === null ? null : DateTime.makeUnsafe(at(completedHour)),
        },
      } as never);
    const turnAt = (service: WorkspaceService.WorkspaceService["Service"], hour: number) =>
      awaitWorkspace(
        service,
        (workspace) => workspace.lastTurnAt !== null && workspace.lastTurnAt >= at(hour),
      ).pipe(Effect.map((workspace) => workspace.lastTurnAt));

    return Effect.gen(function* () {
      const store = yield* WorkspaceStore.WorkspaceStore;
      yield* store.save({
        workspace: {
          id: WorkspaceId.make("ws-oslo"),
          projectId: fixture.projectId,
          name: "oslo",
          worktreePath,
          branch: "oslo",
          baseRef: "main",
          status: "ready",
          pendingOperation: null,
          error: null,
          lastScript: null,
          setupTerminal: null,
          runningScripts: [],
          setupPending: false,
          checkout: { type: "new", startFromOrigin: true },
          createdAt: at(0),
          archivedAt: null,
          lastTurnAt: null,
        },
        archivedThreadIds: [],
        log: "",
      });
      shell("chat-live", 1);
      shell("chat-archived", 3, { archived: true });
      shell("chat-subagent", 9, { subagent: true });

      const service = yield* WorkspaceService.make;
      const [backfilled] = yield* service.list;
      assert.equal(backfilled?.lastTurnAt, at(3));

      // Mid-run updates and subagents never move it; a start and an end do.
      run("run.updated", "chat-live", 4, null);
      run("run.updated", "chat-subagent", 8, 9);
      run("run.created", "chat-live", 5, null);
      assert.equal(yield* turnAt(service, 5), at(5));
      run("run.updated", "chat-live", 5, 6);
      assert.equal(yield* turnAt(service, 6), at(6));

      // A deleted chat's turn stays, and an older one cannot pull it back.
      fixture.shells.delete("chat-live");
      shell("chat-new", null);
      run("run.updated", "chat-new", 2, 2);
      run("run.created", "chat-new", 7, null);
      assert.equal(yield* turnAt(service, 7), at(7));
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
    );
  });

  it.effect("follows the branch its first message names", () => {
    const fixture = makeFixture();
    const registry = makeWorkspaceOwnershipRegistry();
    const record = (name: string, branch: string, checkout: Workspace["checkout"]) => ({
      workspace: {
        id: WorkspaceId.make(`ws-${name}`),
        projectId: fixture.projectId,
        name,
        worktreePath: NodePath.join(fixture.root, name),
        branch,
        baseRef: "main",
        status: "ready" as const,
        pendingOperation: null,
        error: null,
        lastScript: null,
        setupTerminal: null,
        runningScripts: [],
        setupPending: false,
        checkout,
        createdAt: "2026-10-19T00:00:00.000Z",
        archivedAt: null,
        lastTurnAt: null,
      },
      archivedThreadIds: [],
      log: "",
    });
    const renamed = (name: string, branch: string) =>
      fixture.emit({
        type: "thread.metadata-updated",
        threadId: ThreadId.make(`chat-${name}`),
        payload: {
          projectId: fixture.projectId,
          worktreePath: NodePath.join(fixture.root, name),
          branch,
          lineage: { relationshipToParent: null },
        },
      } as never);
    const awaits = (name: string, branch: string) =>
      forkWorkspaceAwaitsBranchName(NodePath.join(fixture.root, name), branch).pipe(
        Effect.provideService(WorkspaceOwnership, registry),
      );

    return Effect.gen(function* () {
      const store = yield* WorkspaceStore.WorkspaceStore;
      yield* store.save(record("oslo", "fork/oslo", { type: "new", startFromOrigin: true }));
      yield* store.save(record("lima", "feature/lima", { type: "branch" }));

      const service = yield* WorkspaceService.make;
      assert.isTrue(yield* awaits("oslo", "fork/oslo"));
      // A branch the user checked out keeps its name.
      assert.isFalse(yield* awaits("lima", "feature/lima"));

      renamed("lima", "fork/elsewhere");
      renamed("oslo", "fork/fix-login-redirect");
      yield* awaitWorkspace(service, (workspace) => workspace.branch === "fork/fix-login-redirect");
      const byName = new Map((yield* service.list).map((workspace) => [workspace.name, workspace]));
      assert.equal(byName.get("lima")?.branch, "feature/lima");
      // Named once, so later chats keep it.
      assert.isFalse(yield* awaits("oslo", "fork/fix-login-redirect"));
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceStore.layer.pipe(Layer.provideMerge(servicesLayer(fixture)))),
      Effect.provideService(WorkspaceOwnership, registry),
    );
  });
});
