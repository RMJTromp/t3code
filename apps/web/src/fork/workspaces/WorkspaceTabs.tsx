import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ContextMenuItem, EnvironmentId, ThreadId, Workspace } from "@t3tools/contracts";
import { ArchiveRestoreIcon, HistoryIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, memo, useEffect, useRef, useState } from "react";

import { resolveRenameCommit } from "../../components/chat/ChatHeader";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { PanelTabCloseButton } from "../../components/ui/panel-tab-close-button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import {
  DraftId,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell, useThreadShells, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { BrailleSpinner } from "./BrailleSpinner";
import { showScriptTerminal } from "./RunScriptMenu";
import { useWorkspaceLastLocation } from "./lastLocation";
import {
  draftsForWorkspace,
  isUserChat,
  neighbourAfterClose,
  owningUserChatId,
  sameWorkspacePath,
  threadsForWorkspace,
  workspaceAcceptsChats,
} from "./logic";
import { useWorkspaceForPath } from "./state";
import { useOpenWorkspace } from "./useOpenWorkspace";
import { useThreadAttention } from "./useThreadAttention";

type TabMenuAction = "mark-unread" | "rename" | "close" | "close-others";
const DRAFT_TITLE = "Untitled";

/** Renders nothing unless the open chat or draft belongs to a workspace. */
export const WorkspaceTabs = memo(function WorkspaceTabs({
  environmentId,
  threadId,
  draftId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId: DraftId | null;
}) {
  const thread = useThreadShell(draftId === null ? scopeThreadRef(environmentId, threadId) : null);
  const draft = useComposerDraftStore((state) =>
    draftId === null ? null : state.getDraftSession(draftId),
  );
  const source = thread ?? draft;
  const workspace = useWorkspaceForPath(environmentId, source?.worktreePath ?? null);
  if (workspace === null || workspace.projectId !== source?.projectId) return null;
  return (
    <WorkspaceTabStrip
      environmentId={environmentId}
      workspace={workspace}
      viewedThreadId={threadId}
      activeThreadId={draftId === null ? threadId : null}
      activeDraftId={draftId}
    />
  );
});

function WorkspaceTabStrip({
  environmentId,
  workspace,
  viewedThreadId,
  activeThreadId,
  activeDraftId,
}: {
  environmentId: EnvironmentId;
  workspace: Workspace;
  /** The chat in view, draft or not; its right panel shows the setup terminal. */
  viewedThreadId: ThreadId;
  activeThreadId: ThreadId | null;
  activeDraftId: DraftId | null;
}) {
  const { newChat, openDraft, openThread } = useOpenWorkspace();
  const { archiveThread, markThreadUnread } = useThreadActions();
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const attentionOf = useThreadAttention();
  const environmentThreads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId,
  );
  const members = threadsForWorkspace(environmentThreads, workspace);
  // A subagent chat has no tab of its own; its spawning chat's tab stands in for it.
  const activeTabId =
    activeThreadId === null
      ? null
      : (owningUserChatId(environmentThreads, activeThreadId) ?? activeThreadId);
  const sentThreadIds = new Set<string>(members.map((thread) => thread.id));
  // Subscribe to a primitive so typing re-renders the strip only when a draft
  // gains or loses its text, not on every keystroke.
  const draftTabsKey = useComposerDraftStore((state) =>
    draftsForWorkspace(state.draftThreadsByThreadKey, workspace, {
      activeDraftId,
      sentThreadIds,
      hasContent: (draftId) => composerDraftHasUserContent(state.draftsByThreadKey[draftId]),
    })
      .map((draft) => `${draft.hasContent ? 1 : 0}${draft.draftId}`)
      .join("\n"),
  );
  const drafts = (draftTabsKey.length === 0 ? [] : draftTabsKey.split("\n")).map((entry) => ({
    draftId: DraftId.make(entry.slice(1)),
    hasContent: entry[0] === "1",
  }));
  const [renamingId, setRenamingId] = useState<ThreadId | null>(null);

  const remember = useWorkspaceLastLocation((state) => state.remember);
  useEffect(() => {
    remember(
      workspace.id,
      activeDraftId === null
        ? { kind: "thread", threadId: activeTabId! }
        : { kind: "draft", draftId: activeDraftId },
    );
  }, [remember, workspace.id, activeDraftId, activeTabId]);

  // Setup streams into this chat's terminal; reveal it once, as setup starts.
  const setupTerminal = workspace.setupTerminal;
  const setupStartedAt =
    setupTerminal !== null &&
    setupTerminal.threadId === viewedThreadId &&
    workspace.lastScript?.kind === "setup" &&
    workspace.lastScript.phase === "running"
      ? workspace.lastScript.startedAt
      : null;
  useEffect(() => {
    if (setupStartedAt === null || setupTerminal === null) return;
    const ref = scopeThreadRef(environmentId, setupTerminal.threadId);
    useRightPanelStore.getState().openTerminal(ref, setupTerminal.terminalId);
  }, [environmentId, setupStartedAt, setupTerminal]);

  // Open a script's terminal once, when it starts in this chat; scripts that
  // were already running when the chat opened stay where the user left them.
  const scriptTerminals = workspace.runningScripts
    .filter((entry) => entry.threadId === viewedThreadId)
    .map((entry) => entry.terminalId)
    .join("\n");
  const seenScriptTerminals = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const current = new Set(scriptTerminals.length === 0 ? [] : scriptTerminals.split("\n"));
    const seen = seenScriptTerminals.current;
    seenScriptTerminals.current = current;
    if (seen === null) return;
    for (const terminalId of current) {
      if (!seen.has(terminalId)) showScriptTerminal(environmentId, viewedThreadId, terminalId);
    }
  }, [environmentId, scriptTerminals, viewedThreadId]);

  const draftIds = new Set<string>(drafts.map((draft) => draft.draftId));
  const tabKeys: ReadonlyArray<string> = [
    ...members.map((thread) => thread.id),
    ...drafts.map((draft) => draft.draftId),
  ];
  const activeKey = activeTabId ?? activeDraftId;
  const selectKey = (key: string) => {
    if (draftIds.has(key)) void openDraft(DraftId.make(key));
    else void openThread(environmentId, key as ThreadId);
  };

  /** Leaves the tab in view before it closes; false when no other tab remains. */
  const leaveClosingTabs = (closing: ReadonlySet<string>) => {
    if (activeKey === null || !closing.has(activeKey)) return true;
    const remaining = tabKeys.filter((key) => !closing.has(key) || key === activeKey);
    const next = neighbourAfterClose(remaining, activeKey);
    if (next === null) return false;
    selectKey(next);
    return true;
  };

  /** Closing archives the chat; the history menu brings it back. */
  const closeChats = async (threadIds: ReadonlyArray<ThreadId>) => {
    // Leave first: upstream's archive opens a fresh draft when it closes the
    // chat in view.
    if (!leaveClosingTabs(new Set(threadIds))) await newChat(environmentId, workspace);
    for (const threadId of threadIds) {
      await archiveThread(scopeThreadRef(environmentId, threadId));
    }
  };

  /** Closing discards the draft, with upstream's undo toast as the way back. */
  const closeDraft = (draftId: DraftId) => {
    if (leaveClosingTabs(new Set([draftId]))) {
      discardComposerDraft(draftId);
      return;
    }
    // The last tab keeps its draft open and only loses the text.
    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    if (session !== null) discardComposerDraft(scopeThreadRef(environmentId, session.threadId));
  };

  const commitRename = (thread: EnvironmentThreadShell, title: string) => {
    setRenamingId(null);
    const resolution = resolveRenameCommit({ title, originalTitle: thread.title });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Chat title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateMetadata({
      environmentId,
      input: { threadId: thread.id, title: resolution.title },
    });
  };

  const showMenu = async (event: MouseEvent, thread: EnvironmentThreadShell) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<TabMenuAction>[] = [
      { id: "mark-unread", label: "Mark as unread" },
      { id: "rename", label: "Rename chat" },
      { id: "close", label: "Close tab" },
      { id: "close-others", label: "Close others", disabled: members.length <= 1 },
    ];
    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    const ref = scopeThreadRef(environmentId, thread.id);
    if (action === "mark-unread") markThreadUnread(ref);
    if (action === "rename") setRenamingId(thread.id);
    if (action === "close") void closeChats([thread.id]);
    if (action === "close-others") {
      void closeChats(members.filter((entry) => entry.id !== thread.id).map((entry) => entry.id));
    }
  };

  const tabListRef = useRef<HTMLDivElement>(null);
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tabKeys.length === 0) return;
    const index = activeKey === null ? -1 : tabKeys.indexOf(activeKey);
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabKeys.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabKeys.length) % tabKeys.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabKeys.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    selectKey(tabKeys[target]!);
    tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div className="flex h-9 min-h-9 shrink-0 items-center gap-1 border-border border-b px-2">
      <ScrollArea radius="none" hideScrollbars scrollFade className="min-w-0 flex-1">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={`${workspace.name} chats`}
          onKeyDown={onTabKeyDown}
          className="flex h-full w-max min-w-full items-center gap-1"
        >
          {members.map((thread) => {
            const attention = attentionOf(thread);
            return (
              <ChatTab
                key={thread.id}
                title={thread.title}
                working={attention.working}
                marker={attention.unread ? "unread" : null}
                active={thread.id === activeTabId}
                renaming={renamingId === thread.id}
                onSelect={() => void openThread(environmentId, thread.id)}
                onClose={() => void closeChats([thread.id])}
                onContextMenu={(event) => void showMenu(event, thread)}
                onFinishRename={(title) => commitRename(thread, title)}
              />
            );
          })}
          {drafts.map((draft) => (
            <ChatTab
              key={draft.draftId}
              title={DRAFT_TITLE}
              closeLabel="Discard draft"
              working={false}
              marker={draft.hasContent ? "draft" : null}
              active={draft.draftId === activeDraftId}
              renaming={false}
              onSelect={() => void openDraft(draft.draftId)}
              onClose={() => closeDraft(draft.draftId)}
            />
          ))}
          {/* Always a fresh draft: unsent ones keep their own tabs. */}
          <button
            type="button"
            aria-label="New chat"
            disabled={!workspaceAcceptsChats(workspace)}
            onClick={() => void newChat(environmentId, workspace)}
            className="cursor-pointer flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
      </ScrollArea>
      <ClosedChatsMenu
        environmentId={environmentId}
        workspace={workspace}
        onReopen={(threadId) => void openThread(environmentId, threadId)}
      />
    </div>
  );
}

/** Same markup and look as upstream's right-panel tabs (`RightPanelTab`). */
function ChatTab(props: {
  title: string;
  closeLabel?: string;
  working: boolean;
  /** A dot after the title: a finished turn to read, or text waiting to be sent. */
  marker: "unread" | "draft" | null;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  onFinishRename?: (title: string) => void;
}) {
  const unread = props.marker === "unread";
  return (
    <div
      data-active-tab={props.active}
      onContextMenu={props.onContextMenu}
      className={cn(
        "cursor-pointer group/tab flex h-6 max-w-44 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
        props.active
          ? "bg-accent text-foreground"
          : unread
            ? "font-medium text-foreground hover:bg-accent/60"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {/* The icon turns into the close button on hover, as in upstream's tabs. */}
      <PanelTabCloseButton
        label={props.closeLabel ?? `Close ${props.title}`}
        onClick={props.onClose}
      >
        {props.working ? (
          <BrailleSpinner className="text-2xs" />
        ) : (
          <MessageSquareIcon className="size-3" />
        )}
      </PanelTabCloseButton>
      {props.renaming ? (
        <input
          aria-label="Chat name"
          className="w-28 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
          defaultValue={props.title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => props.onFinishRename?.(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = props.title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={props.active}
          tabIndex={props.active ? 0 : -1}
          className="cursor-pointer flex min-w-0 items-center gap-1 outline-none focus-visible:underline"
          onClick={props.onSelect}
        >
          <span className="truncate">{props.title}</span>
          {props.marker !== null && !props.active ? (
            <span
              aria-label={unread ? "Unread" : "Unsent draft"}
              className={cn("size-1.5 shrink-0 rounded-full", unread ? "bg-primary" : "bg-warning")}
            />
          ) : null}
        </button>
      )}
    </div>
  );
}

/** The way back for closed chats. */
function ClosedChatsMenu({
  environmentId,
  workspace,
  onReopen,
}: {
  environmentId: EnvironmentId;
  workspace: Workspace;
  onReopen: (threadId: ThreadId) => void;
}) {
  const { unarchiveThread } = useThreadActions();
  const { snapshots } = useArchivedThreadSnapshots([environmentId]);
  const closed = snapshots
    .flatMap((entry) => entry.snapshot.threads)
    .filter(
      (thread) =>
        isUserChat(thread) &&
        thread.projectId === workspace.projectId &&
        sameWorkspacePath(thread.worktreePath, workspace.worktreePath),
    );
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Reopen closed chats"
            disabled={closed.length === 0}
          />
        }
      >
        <HistoryIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Closed chats</MenuGroupLabel>
          {closed.map((thread) => (
            <MenuItem
              key={thread.id}
              onClick={async () => {
                const ref = scopeThreadRef(environmentId, thread.id);
                const result = await unarchiveThread(ref);
                // Navigating before the chat is back in the active list lands on a
                // missing thread, which upstream redirects to another project.
                if (result._tag === "Success" && (await waitForThreadShell(ref))) {
                  onReopen(thread.id);
                }
              }}
            >
              <ArchiveRestoreIcon />
              <span className="max-w-64 truncate">{thread.title}</span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
