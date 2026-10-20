import {
  FORK_WORKSPACE_WS_METHODS,
  type Workspace,
  type WorkspaceCommand,
  type WorkspaceRefInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import * as WorkspaceService from "./WorkspaceService.ts";
import * as WorkspaceStore from "./WorkspaceStore.ts";

export const ForkWorkspaceLayer = WorkspaceService.layer.pipe(
  Layer.provide(WorkspaceStore.layer),
  Layer.provide(ProcessRunner.layer),
);

/** Transport only: decode, call one service method, let the typed error through. */
export const makeForkWorkspaceHandlers = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService.WorkspaceService;
  const withWorkspace = Effect.map((workspace: Workspace) => ({ workspace }));
  return {
    [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCommand]: (command: WorkspaceCommand) => {
      switch (command.type) {
        case "create":
          return workspaces.create(command).pipe(withWorkspace);
        case "archive":
          return workspaces.archive(command).pipe(withWorkspace);
        case "unarchive":
          return workspaces.unarchive(command.workspaceId).pipe(withWorkspace);
        case "retry":
          return workspaces.retry(command.workspaceId).pipe(withWorkspace);
        case "runScript":
          return workspaces.runProjectScript(command).pipe(withWorkspace);
        case "setProjectScripts":
          return workspaces.setProjectScripts(command.scripts).pipe(Effect.as({ workspace: null }));
        case "listIssues":
          return workspaces
            .listIssues(command)
            .pipe(Effect.map((issues) => ({ workspace: null, issues })));
        case "listPullRequests":
          return workspaces
            .listPullRequests(command)
            .pipe(Effect.map((pullRequests) => ({ workspace: null, pullRequests })));
        case "readIssue":
          return workspaces
            .readIssue(command)
            .pipe(Effect.map((issue) => ({ workspace: null, issues: [issue] })));
      }
    },
    [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces]: () => workspaces.stream,
    [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog]: (input: WorkspaceRefInput) =>
      workspaces.logStream(input.workspaceId),
  } as const;
});
