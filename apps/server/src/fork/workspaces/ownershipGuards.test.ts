import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, WorkspaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { makeWorkspaceOwnershipRegistry, WorkspaceOwnership } from "./WorkspaceOwnership.ts";

it.effect("a new chat in a workspace does not rerun the project's setup action", () => {
  const projectId = ProjectId.make("project-guard");
  const opened: Array<string> = [];
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                title: "Project",
                workspaceRoot: "/repo",
                repositoryIdentity: null,
                faviconPath: null,
                defaultModelSelection: null,
                scripts: [
                  {
                    id: "setup",
                    name: "Setup",
                    command: "vp install",
                    icon: "configure" as const,
                    runOnWorktreeCreate: true,
                  },
                ],
                createdAt: "2026-10-19T00:00:00.000Z",
                updatedAt: "2026-10-19T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open: (input) =>
            Effect.sync(() => {
              opened.push(input.cwd);
              return {
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                worktreePath: null,
                status: "running" as const,
                pid: 1,
                history: "",
                exitCode: null,
                exitSignal: null,
                label: "Shell",
                updatedAt: "2026-10-19T00:00:00.000Z",
              };
            }),
          write: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );
  const registry = makeWorkspaceOwnershipRegistry();
  const workspaceId = WorkspaceId.make("ws-guard");
  registry.set(workspaceId, ["/worktrees/repo/oslo"], {
    workspaceId,
    status: "ready",
    awaitingBranchName: null,
  });

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const owned = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/worktrees/repo/oslo/",
    });
    assert.deepEqual(owned, { status: "no-script" });

    const other = yield* runner.runForThread({
      threadId: "thread-2",
      projectId,
      worktreePath: "/worktrees/repo/other",
    });
    assert.equal(other.status, "started");
    assert.deepEqual(opened, ["/worktrees/repo/other"]);
  }).pipe(Effect.provide(layer), Effect.provideService(WorkspaceOwnership, registry));
});
