import {
  normalizeWorkspacePath,
  type ProjectId,
  type Workspace,
  type WorkspaceLogEvent,
} from "@t3tools/contracts";

/** Matches the server's retained window so a long-lived tab cannot grow without bound. */
const LOG_MAX_CHARS = 256 * 1024;

export function accumulateWorkspaceLog(log: string, event: WorkspaceLogEvent): string {
  const next = event.type === "snapshot" ? event.text : log + event.text;
  return next.length <= LOG_MAX_CHARS ? next : next.slice(-LOG_MAX_CHARS);
}

export function sameWorkspacePath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

export function workspaceForPath(
  workspaces: ReadonlyArray<Workspace>,
  worktreePath: string,
): Workspace | null {
  return (
    workspaces.find((workspace) => sameWorkspacePath(workspace.worktreePath, worktreePath)) ?? null
  );
}

interface WorkspaceThreadCandidate {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

/** A workspace's chats are its project's threads that run in its folder. */
export function threadsForWorkspace<T extends WorkspaceThreadCandidate>(
  threads: ReadonlyArray<T>,
  workspace: Pick<Workspace, "projectId" | "worktreePath">,
): ReadonlyArray<T> {
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.projectId === workspace.projectId &&
        sameWorkspacePath(thread.worktreePath, workspace.worktreePath),
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Project threads that predate workspaces or came from clients without them. */
export function unassignedProjectThreads<T extends WorkspaceThreadCandidate>(
  threads: ReadonlyArray<T>,
  projectId: ProjectId,
  workspaces: ReadonlyArray<Workspace>,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.projectId === projectId &&
      !workspaces.some(
        (workspace) =>
          workspace.projectId === projectId &&
          sameWorkspacePath(thread.worktreePath, workspace.worktreePath),
      ),
  );
}

export function workspaceDraftSlot(workspace: Pick<Workspace, "id">): string {
  return `#fork-workspace:${workspace.id}`;
}

export function workspaceAcceptsChats(workspace: Pick<Workspace, "status">): boolean {
  return workspace.status === "ready" || workspace.status === "failed";
}

export type NewThreadRouting =
  | { readonly kind: "upstream" }
  | { readonly kind: "workspace"; readonly workspace: Workspace }
  | { readonly kind: "choose-workspace" };

/**
 * Where an upstream "new thread" request goes. Projectless chats and explicit
 * worktree requests keep upstream behavior; other project chats belong to a
 * workspace, preferably the one the user is looking at.
 */
export function routeNewThread(input: {
  readonly isScratchProject: boolean;
  readonly projectId: ProjectId;
  readonly requestedWorktreePath: string | null | undefined;
  readonly currentWorktreePath: string | null;
  readonly workspaces: ReadonlyArray<Workspace>;
}): NewThreadRouting {
  if (input.isScratchProject) return { kind: "upstream" };
  const inProject = input.workspaces.filter(
    (workspace) => workspace.projectId === input.projectId && workspaceAcceptsChats(workspace),
  );
  if (input.requestedWorktreePath) {
    const requested = workspaceForPath(inProject, input.requestedWorktreePath);
    return requested ? { kind: "workspace", workspace: requested } : { kind: "upstream" };
  }
  const current =
    input.currentWorktreePath === null
      ? null
      : workspaceForPath(inProject, input.currentWorktreePath);
  return current ? { kind: "workspace", workspace: current } : { kind: "choose-workspace" };
}

/** The tab to show after closing `closingKey`: the next one, else the previous. */
export function neighbourAfterClose(
  keys: ReadonlyArray<string>,
  closingKey: string,
): string | null {
  const index = keys.indexOf(closingKey);
  if (index < 0) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

/** Any chat update counts as activity; a workspace without chats dates from its creation. */
export function workspaceLastActivity(
  workspace: Pick<Workspace, "createdAt">,
  members: ReadonlyArray<{ readonly updatedAt: string }>,
): string {
  return members.reduce(
    (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
    workspace.createdAt,
  );
}

/** "3h ago" → "3h", "just now" → "now", as upstream's sidebar shortens it. */
export function compactRelativeTime(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}
