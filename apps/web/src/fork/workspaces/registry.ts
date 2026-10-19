import type { EnvironmentId, Workspace } from "@t3tools/contracts";

import { workspaceForPath } from "./logic";

/**
 * Upstream hooks import this file, not `state.ts`, so their tests and module
 * graphs never pull in the connection runtime. `state.ts` registers the reader
 * when the app loads the workspace UI.
 */
type WorkspaceReader = (environmentId: EnvironmentId) => ReadonlyArray<Workspace>;

let reader: WorkspaceReader | null = null;

export function registerWorkspaceReader(next: WorkspaceReader): void {
  reader = next;
}

const UPSTREAM_SIDEBAR_KEY = "t3fork:use-upstream-sidebar";

/** Set `t3fork:use-upstream-sidebar` in localStorage to fall back to upstream's sidebar. */
export function forkWorkspaceSidebarEnabled(): boolean {
  try {
    return window.localStorage.getItem(UPSTREAM_SIDEBAR_KEY) === null;
  } catch {
    return true;
  }
}

/** Null when the workspace UI is off, so callers keep upstream behavior. */
export function readEnvironmentWorkspaces(
  environmentId: EnvironmentId,
): ReadonlyArray<Workspace> | null {
  if (reader === null || !forkWorkspaceSidebarEnabled()) return null;
  return reader(environmentId);
}

/** Upstream's delete flow offers to remove a thread's worktree; never a workspace's. */
export function forkReleasableWorktree(
  environmentId: EnvironmentId,
  worktreePath: string | null,
): string | null {
  if (worktreePath === null) return null;
  const workspaces = readEnvironmentWorkspaces(environmentId) ?? [];
  return workspaceForPath(workspaces, worktreePath) === null ? worktreePath : null;
}
