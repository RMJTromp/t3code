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
  type OrchestrationV2ServerCommand,
  type Workspace,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
      });
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(WorkspaceOwnership, registry));

      assert.isTrue(yield* run(forkWorkspaceOwnsPath("/private/tmp/link/oslo")));
      assert.isFalse(yield* run(forkWorkspaceOwnsPath("/tmp/link/other")));
      const blocked = yield* run(
        forkGuardWorktreeRemoval({ cwd: "/repo", path: "/tmp/link/oslo" }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(blocked));

      registry.set(owned, ["/tmp/link/oslo"], { workspaceId: owned, status: "archiving" });
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
  return {
    root,
    projectId: ProjectId.make("project-1"),
    threads: [],
    dispatched: [],
    terminals: [],
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
      getById: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      remoteExists: () => Effect.succeed(false),
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
    Stream.map((workspaces) => workspaces.find(predicate)),
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
      const ready = yield* awaitWorkspace(
        service,
        (workspace) => workspace.status === "ready" && scriptDone(workspace),
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
        createdAt: "2026-10-19T00:00:00.000Z",
        archivedAt: null,
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
});
