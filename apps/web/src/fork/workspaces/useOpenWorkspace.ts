import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId, Workspace } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { readProject, readThreadShell, readThreadShells } from "../../state/entities";
import { newThreadId } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { withForkDraftSlot } from "./interceptNewThread";
import { useWorkspaceLastLocation } from "./lastLocation";
import { threadsForWorkspace, workspaceDraftSlot } from "./logic";
import { forkWorkspaceEnvironment } from "./state";

/** The draft slot upstream's new-thread handler uses for this workspace. */
export function useWorkspaceDraftKey() {
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  return (environmentId: EnvironmentId, workspace: Workspace): string | null => {
    const project = readProject(scopeProjectRef(environmentId, workspace.projectId));
    if (project === null) return null;
    return withForkDraftSlot(deriveLogicalProjectKeyFromSettings(project, groupingSettings), {
      draftSlot: workspaceDraftSlot(workspace),
    });
  };
}

/** A workspace draft that has not been sent yet, if one exists. */
export function openWorkspaceDraftId(logicalProjectKey: string | null): DraftId | null {
  if (logicalProjectKey === null) return null;
  const session = useComposerDraftStore
    .getState()
    .getDraftSessionByLogicalProjectKey(logicalProjectKey);
  if (session === null || session.promotedTo != null) return null;
  return readThreadShell(scopeThreadRef(session.environmentId, session.threadId)) === null
    ? session.draftId
    : null;
}

export function useOpenWorkspace() {
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const draftKey = useWorkspaceDraftKey();

  const newChat = (environmentId: EnvironmentId, workspace: Workspace, threadId?: ThreadId) =>
    handleNewThread(scopeProjectRef(environmentId, workspace.projectId), {
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      envMode: "worktree",
      draftSlot: workspaceDraftSlot(workspace),
      ...(threadId === undefined ? {} : { threadId }),
    });

  const openDraft = (draftId: DraftId) => navigate({ to: "/draft/$draftId", params: { draftId } });

  const openThread = (
    environmentId: EnvironmentId,
    threadId: Parameters<typeof scopeThreadRef>[1],
  ) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  /** Where the user left this workspace, else its unsent draft, last chat, or a fresh draft. */
  const open = async (environmentId: EnvironmentId, workspace: Workspace) => {
    const members = threadsForWorkspace(
      readThreadShells().filter((thread) => thread.environmentId === environmentId),
      workspace,
    );
    const pendingDraft = openWorkspaceDraftId(draftKey(environmentId, workspace));
    const last = useWorkspaceLastLocation.getState().byWorkspace[workspace.id];
    if (last?.kind === "thread" && members.some((thread) => thread.id === last.threadId)) {
      await openThread(environmentId, last.threadId);
      return;
    }
    if (last?.kind === "draft" && last.draftId === pendingDraft) {
      await openDraft(pendingDraft);
      return;
    }
    if (pendingDraft !== null) {
      await openDraft(pendingDraft);
      return;
    }
    const latest = members.toSorted((left, right) =>
      (right.lastVisitedAt ?? right.updatedAt).localeCompare(left.lastVisitedAt ?? left.updatedAt),
    )[0];
    if (latest !== undefined) {
      await openThread(environmentId, latest.id);
      return;
    }
    await newChat(environmentId, workspace);
  };

  return { open, newChat, openDraft, openThread };
}

/**
 * Creates a workspace and opens its first chat at once. The chat's thread id
 * is chosen here so the server runs setup in that chat's terminal.
 */
export function useCreateWorkspace() {
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  const { newChat } = useOpenWorkspace();
  return async (environmentId: EnvironmentId, projectId: ProjectId): Promise<Workspace | null> => {
    const setupThreadId = newThreadId();
    const result = await command({
      environmentId,
      input: { type: "create", projectId, setupThreadId },
    });
    const workspace = result._tag === "Success" ? result.value.workspace : null;
    if (workspace === null) return null;
    await newChat(environmentId, workspace, setupThreadId);
    return workspace;
  };
}
