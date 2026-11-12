import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  Workspace,
  WorkspaceCommand,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildMessageContext } from "../../lib/composerContextRecords";
import {
  readProject,
  readThreadShell,
  readThreadShells,
  waitForThreadShell,
} from "../../state/entities";
import { newThreadId } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { withForkDraftSlot } from "./interceptNewThread";
import { useWorkspaceLastLocation } from "./lastLocation";
import { sameWorkspacePath, threadsForWorkspace, workspaceDraftSlot } from "./logic";
import { forkWorkspaceEnvironment } from "./state";

/** The draft slot upstream's new-thread handler uses for this workspace. */
function useWorkspaceDraftKey() {
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  return (environmentId: EnvironmentId, workspace: Workspace): string | null => {
    const project = readProject(scopeProjectRef(environmentId, workspace.projectId));
    if (project === null) return null;
    return withForkDraftSlot(deriveLogicalProjectKeyFromSettings(project, groupingSettings), {
      draftSlot: workspaceDraftSlot(workspace),
    });
  };
}

/** Whether a draft is still an unsent chat in this workspace. */
function isOpenWorkspaceDraft(draftId: DraftId, workspace: Workspace): boolean {
  const session = useComposerDraftStore.getState().getDraftSession(draftId);
  return (
    session !== null &&
    session.promotedTo == null &&
    session.projectId === workspace.projectId &&
    sameWorkspacePath(session.worktreePath, workspace.worktreePath) &&
    readThreadShell(scopeThreadRef(session.environmentId, session.threadId)) === null
  );
}

/** The workspace's mapped draft that has not been sent yet, if one exists. */
function openWorkspaceDraftId(logicalProjectKey: string | null): DraftId | null {
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
    if (last?.kind === "draft" && isOpenWorkspaceDraft(last.draftId, workspace)) {
      await openDraft(last.draftId);
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

/** What the new-workspace dialog chose; the sidebar's quick create passes none. */
export interface WorkspaceCreateOptions {
  readonly baseRef?: string;
  readonly checkout?: Extract<WorkspaceCommand, { type: "create" }>["checkout"];
  readonly prompt?: string;
  /** Records behind `#` pull request chips in `prompt`. */
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Creates a workspace and opens its first chat at once. The chat's thread id
 * is chosen here so the server runs setup in that chat's terminal. With a
 * prompt, the server starts that chat with it, so it sends with no client
 * watching and the composer stays free for the next message.
 */
export function useCreateWorkspace() {
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  const { newChat, openThread } = useOpenWorkspace();
  return async (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    options: WorkspaceCreateOptions = {},
  ): Promise<Workspace | null> => {
    const setupThreadId = newThreadId();
    const prompt = options.prompt?.trim() ?? "";
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: options.reviewComments ?? [],
      previewAnnotations: [],
    });
    const firstMessage =
      prompt.length > 0 && options.modelSelection !== undefined && options.runtimeMode !== undefined
        ? {
            text: prompt,
            title: deriveThreadTitleSeed({ text: prompt, attachments: [] }),
            modelSelection: options.modelSelection,
            runtimeMode: options.runtimeMode,
            ...(context === undefined ? {} : { context }),
          }
        : undefined;
    const result = await command({
      environmentId,
      input: {
        type: "create",
        projectId,
        setupThreadId,
        ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
        ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
        ...(firstMessage === undefined ? {} : { firstMessage }),
      },
    });
    const workspace = result._tag === "Success" ? result.value.workspace : null;
    if (workspace === null) return null;
    if (
      firstMessage !== undefined &&
      (await waitForThreadShell(scopeThreadRef(environmentId, setupThreadId)))
    ) {
      await openThread(environmentId, setupThreadId);
      return workspace;
    }
    // No server chat: the prompt waits in a draft for the user to send.
    const opened = await newChat(environmentId, workspace, setupThreadId);
    if (opened !== null) {
      const drafts = useComposerDraftStore.getState();
      if (options.modelSelection !== undefined) {
        drafts.setModelSelection(opened.draftId, options.modelSelection, { explicit: true });
      }
      if (options.runtimeMode !== undefined) {
        drafts.setRuntimeMode(opened.draftId, options.runtimeMode);
      }
      if (prompt.length > 0) {
        drafts.setPrompt(opened.draftId, prompt);
        // After the prompt, whose chips already reference them, so none are appended twice.
        if (options.reviewComments !== undefined && options.reviewComments.length > 0) {
          drafts.setReviewComments(opened.draftId, options.reviewComments);
        }
      }
    }
    return workspace;
  };
}
