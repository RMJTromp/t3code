import type { ScopedProjectRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { readProject, readThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { openNewWorkspaceDialog } from "./dialogStore";
import { routeNewThread, workspaceAcceptsChats, workspaceDraftSlot } from "./logic";
import { readEnvironmentWorkspaces } from "./registry";

interface NewThreadOptions {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly envMode?: "local" | "worktree";
  readonly replace?: boolean;
  readonly draftSlot?: string;
}

export type ForkNewThreadInterception<O> =
  | { readonly kind: "pass"; readonly options: O | undefined }
  | { readonly kind: "handled" };

function currentWorktreePath(target: ThreadRouteTarget | null, projectRef: ScopedProjectRef) {
  if (target === null) return null;
  const source =
    target.kind === "server"
      ? readThreadShell(target.threadRef)
      : useComposerDraftStore.getState().getDraftSession(target.draftId);
  if (
    source === null ||
    source.environmentId !== projectRef.environmentId ||
    source.projectId !== projectRef.projectId
  ) {
    return null;
  }
  return source.worktreePath;
}

/**
 * Upstream's single entry for new threads (palette, keybindings, sidebar, the
 * index route) asks here first, so project chats land in a workspace.
 */
export function forkInterceptNewThread<O extends NewThreadOptions>(
  projectRef: ScopedProjectRef,
  options: O | undefined,
  currentRouteTarget: ThreadRouteTarget | null,
): ForkNewThreadInterception<O> {
  if (options?.draftSlot !== undefined) return { kind: "pass", options };
  const workspaces = readEnvironmentWorkspaces(projectRef.environmentId);
  if (workspaces === null) return { kind: "pass", options };
  const project = readProject(projectRef);
  if (project === null) return { kind: "pass", options };
  const routing = routeNewThread({
    isScratchProject: project.isScratch === true,
    projectId: projectRef.projectId,
    requestedWorktreePath: options?.worktreePath,
    currentWorktreePath: currentWorktreePath(currentRouteTarget, projectRef),
    workspaces,
  });
  if (routing.kind === "upstream") return { kind: "pass", options };

  // The index route opens a draft on its own and retries on null, so it gets
  // the newest workspace (or upstream's draft) rather than a dialog loop.
  const workspace =
    routing.kind === "workspace"
      ? routing.workspace
      : currentRouteTarget === null && options?.replace === true
        ? (workspaces
            .filter(
              (entry) => entry.projectId === projectRef.projectId && workspaceAcceptsChats(entry),
            )
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null)
        : null;
  if (workspace === null) {
    if (currentRouteTarget === null && options?.replace === true) return { kind: "pass", options };
    openNewWorkspaceDialog({
      environmentId: projectRef.environmentId,
      projectId: projectRef.projectId,
    });
    return { kind: "handled" };
  }
  return {
    kind: "pass",
    options: {
      ...options,
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      envMode: "worktree",
      draftSlot: workspaceDraftSlot(workspace),
    } as O,
  };
}

/** Keeps each workspace's unsent draft separate from its project's other drafts. */
export function withForkDraftSlot(
  logicalProjectKey: string,
  options: { readonly draftSlot?: string } | undefined,
): string {
  return options?.draftSlot === undefined
    ? logicalProjectKey
    : logicalProjectKey + options.draftSlot;
}
