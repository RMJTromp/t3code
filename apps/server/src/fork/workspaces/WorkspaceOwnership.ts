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
  /** True until the workspace's setup script settles, either way. */
  readonly setupPending?: boolean;
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
  /** Resumes once the owning workspace's setup settles; at once when nothing is pending. */
  readonly awaitSetup: (path: string) => Effect.Effect<void>;
}

export function makeWorkspaceOwnershipRegistry(): WorkspaceOwnershipRegistry {
  const owners = new Map<string, WorkspaceOwner>();
  const keysByWorkspace = new Map<WorkspaceId, ReadonlyArray<string>>();
  const setupWaiters = new Map<WorkspaceId, Set<() => void>>();
  const ownerOf = (path: string) => owners.get(normalizeWorkspacePath(path)) ?? null;
  return {
    set: (workspaceId, paths, owner) => {
      for (const key of keysByWorkspace.get(workspaceId) ?? []) owners.delete(key);
      const keys = [...new Set(paths.map(normalizeWorkspacePath))];
      keysByWorkspace.set(workspaceId, keys);
      for (const key of keys) owners.set(key, owner);
      if (setupBlocks(owner)) return;
      for (const resume of setupWaiters.get(workspaceId) ?? []) resume();
      setupWaiters.delete(workspaceId);
    },
    ownerOf,
    awaitSetup: (path) =>
      Effect.callback<void>((resume) => {
        const owner = ownerOf(path);
        if (owner === null || !setupBlocks(owner)) return resume(Effect.void);
        const waiter = () => resume(Effect.void);
        const waiters = setupWaiters.get(owner.workspaceId) ?? new Set();
        setupWaiters.set(owner.workspaceId, waiters.add(waiter));
        return Effect.sync(() => waiters.delete(waiter));
      }),
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

/** A failed or archived workspace will never finish setup, so nothing waits on it. */
function setupBlocks(owner: WorkspaceOwner): boolean {
  return owner.setupPending === true && (owner.status === "creating" || owner.status === "ready");
}

/** True while a live workspace owns the folder; it, not upstream, manages that checkout. */
export const forkWorkspaceOwnsPath = (path: string): Effect.Effect<boolean> =>
  Effect.map(Effect.service(WorkspaceOwnership), (registry) => {
    const owner = registry.ownerOf(path);
    return owner !== null && owner.status !== "archived";
  });

/**
 * Like `forkWorkspaceOwnsPath`, but first waits out the workspace's setup, so a
 * chat's first turn starts in a set-up folder even with no client watching.
 */
export const forkWorkspaceSetupSettled = (path: string): Effect.Effect<boolean> =>
  Effect.flatMap(Effect.service(WorkspaceOwnership), (registry) =>
    Effect.andThen(registry.awaitSetup(path), forkWorkspaceOwnsPath(path)),
  );

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
