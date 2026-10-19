import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_WORKSPACE_WS_METHODS,
  type EnvironmentId,
  type Workspace,
  type WorkspaceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { accumulateWorkspaceLog, workspaceForPath } from "./logic";
import { registerWorkspaceReader } from "./registry";

const EMPTY_WORKSPACES: ReadonlyArray<Workspace> = [];
const EMPTY_WORKSPACES_ATOM = Atom.make(EMPTY_WORKSPACES).pipe(
  Atom.withLabel("fork:environment-workspaces:empty"),
);

export const forkWorkspaceEnvironment = {
  workspaces: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:workspaces",
    tag: FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces,
  }),
  // The server sends the retained log once, then only appended output.
  log: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "fork:workspace-log",
    tag: FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog,
    transform: (stream) => stream.pipe(Stream.scan(() => "", accumulateWorkspaceLog)),
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspace-create",
    tag: FORK_WORKSPACE_WS_METHODS.forkWorkspacesCreate,
  }),
  archive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspace-archive",
    tag: FORK_WORKSPACE_WS_METHODS.forkWorkspacesArchive,
  }),
  unarchive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspace-unarchive",
    tag: FORK_WORKSPACE_WS_METHODS.forkWorkspacesUnarchive,
  }),
  retry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:workspace-retry",
    tag: FORK_WORKSPACE_WS_METHODS.forkWorkspacesRetry,
  }),
};

// A server without the fork answers with an error; treat it as having no workspaces.
export const environmentWorkspacesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<Workspace> => {
    const result = get(forkWorkspaceEnvironment.workspaces({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_WORKSPACES);
  }).pipe(Atom.withLabel(`fork:environment-workspaces:${environmentId}`)),
);

export function useEnvironmentWorkspaces(environmentId: EnvironmentId): ReadonlyArray<Workspace> {
  return useAtomValue(environmentWorkspacesAtom(environmentId));
}

export function useWorkspaceLog(environmentId: EnvironmentId, workspaceId: WorkspaceId): string {
  const result = useAtomValue(
    forkWorkspaceEnvironment.log({ environmentId, input: { workspaceId } }),
  );
  return Option.getOrElse(AsyncResult.value(result), () => "");
}

registerWorkspaceReader((environmentId) =>
  appAtomRegistry.get(environmentWorkspacesAtom(environmentId)),
);

export function useWorkspaceForPath(
  environmentId: EnvironmentId | null,
  worktreePath: string | null,
): Workspace | null {
  const workspaces = useAtomValue(
    environmentId === null ? EMPTY_WORKSPACES_ATOM : environmentWorkspacesAtom(environmentId),
  );
  return worktreePath === null ? null : workspaceForPath(workspaces, worktreePath);
}

const allWorkspacesAtom = Atom.make((get): ReadonlyArray<Workspace> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) =>
    get(environmentWorkspacesAtom(environmentId)),
  ),
).pipe(Atom.withLabel("fork:all-workspaces"));

/** True for any environment's workspace folder; used where only a path is at hand. */
export function useIsWorkspacePath(worktreePath: string | null): boolean {
  const workspaces = useAtomValue(allWorkspacesAtom);
  return worktreePath !== null && workspaceForPath(workspaces, worktreePath) !== null;
}
