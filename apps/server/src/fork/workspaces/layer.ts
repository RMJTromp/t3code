import {
  FORK_WORKSPACE_WS_METHODS,
  type WorkspaceCreateInput,
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
  return {
    [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCreate]: (input: WorkspaceCreateInput) =>
      workspaces.create(input),
    [FORK_WORKSPACE_WS_METHODS.forkWorkspacesArchive]: workspaces.archive,
    [FORK_WORKSPACE_WS_METHODS.forkWorkspacesUnarchive]: (input: WorkspaceRefInput) =>
      workspaces.unarchive(input.workspaceId),
    [FORK_WORKSPACE_WS_METHODS.forkWorkspacesRetry]: (input: WorkspaceRefInput) =>
      workspaces.retry(input.workspaceId),
    [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces]: () => workspaces.stream,
    [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog]: (input: WorkspaceRefInput) =>
      workspaces.logStream(input.workspaceId),
  } as const;
});
