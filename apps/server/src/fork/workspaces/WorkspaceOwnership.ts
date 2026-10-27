import {
  GitCommandError,
  normalizeWorkspacePath,
  type WorkspaceId,
  type WorkspaceStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface WorkspaceOwner {
  readonly workspaceId: WorkspaceId;
  readonly status: WorkspaceStatus;
  /** The placeholder city branch, until the first message names it. */
  readonly awaitingBranchName: string | null;
}

export interface WorkspaceOwnershipRegistry {
  /**
   * `paths` are every spelling of one checkout (as created and its real path),
   * so a caller holding either finds the owner without touching the disk.
   */
  readonly set: (
    workspaceId: WorkspaceId,
    paths: ReadonlyArray<string>,
    owner: WorkspaceOwner,
  ) => void;
  readonly ownerOf: (path: string) => WorkspaceOwner | null;
}

export function makeWorkspaceOwnershipRegistry(): WorkspaceOwnershipRegistry {
  const owners = new Map<string, WorkspaceOwner>();
  const keysByWorkspace = new Map<WorkspaceId, ReadonlyArray<string>>();
  return {
    set: (workspaceId, paths, owner) => {
      for (const key of keysByWorkspace.get(workspaceId) ?? []) owners.delete(key);
      const keys = [...new Set(paths.map(normalizeWorkspacePath))];
      keysByWorkspace.set(workspaceId, keys);
      for (const key of keys) owners.set(key, owner);
    },
    ownerOf: (path) => owners.get(normalizeWorkspacePath(path)) ?? null,
  };
}

/**
 * A Reference rather than a Service so upstream code can consult it with one
 * line and no layer wiring: without the fork layer it is simply empty.
 */
export const WorkspaceOwnership = Context.Reference<WorkspaceOwnershipRegistry>(
  "t3/fork/workspaces/WorkspaceOwnership",
  { defaultValue: makeWorkspaceOwnershipRegistry },
);

/** True while a live workspace owns the folder; it, not upstream, manages that checkout. */
export const forkWorkspaceOwnsPath = (path: string): Effect.Effect<boolean> =>
  Effect.map(Effect.service(WorkspaceOwnership), (registry) => {
    const owner = registry.ownerOf(path);
    return owner !== null && owner.status !== "archived";
  });

/** Lets upstream's first-message branch rename treat a workspace's city branch as temporary. */
export const forkWorkspaceAwaitsBranchName = (
  path: string,
  branch: string,
): Effect.Effect<boolean> =>
  Effect.map(Effect.service(WorkspaceOwnership), (registry) => {
    const owner = registry.ownerOf(path);
    return owner !== null && owner.status !== "archived" && owner.awaitingBranchName === branch;
  });

/** Only the workspace's own archive may remove its checkout. */
export const forkGuardWorktreeRemoval = (input: {
  readonly cwd: string;
  readonly path: string;
}): Effect.Effect<void, GitCommandError> =>
  Effect.flatMap(Effect.service(WorkspaceOwnership), (registry) => {
    const owner = registry.ownerOf(input.path);
    if (owner === null || owner.status === "archiving" || owner.status === "archived") {
      return Effect.void;
    }
    return Effect.fail(
      new GitCommandError({
        operation: "GitWorkflowService.removeWorktree",
        command: "git worktree remove",
        cwd: input.cwd,
        detail: "This worktree belongs to a workspace. Archive the workspace instead.",
      }),
    );
  });
