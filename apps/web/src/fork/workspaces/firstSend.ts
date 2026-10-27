import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { toastManager } from "../../components/ui/toast";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useWorkspaceForPath } from "./state";

/**
 * Drafts the new-workspace dialog filled with a prompt, by thread id. The send
 * waits only for the folder to exist; the server holds the turn until setup
 * finishes, so it starts even if the user has left the chat. In memory only:
 * after a reload the prompt simply stays in the composer.
 */
const usePendingFirstSends = create<{ readonly threadIds: ReadonlySet<ThreadId> }>(() => ({
  threadIds: new Set(),
}));

/** Call once the draft holds the prompt and model to send. */
export function queueWorkspaceFirstSend(threadId: ThreadId): void {
  usePendingFirstSends.setState(({ threadIds }) => ({
    threadIds: new Set(threadIds).add(threadId),
  }));
}

/** False when it was not queued, so only one caller ever sends. */
function takeWorkspaceFirstSend(threadId: ThreadId): boolean {
  const { threadIds } = usePendingFirstSends.getState();
  if (!threadIds.has(threadId)) return false;
  const next = new Set(threadIds);
  next.delete(threadId);
  usePendingFirstSends.setState({ threadIds: next });
  return true;
}

/**
 * Sends a queued draft through ChatView's own send once its workspace's folder
 * exists. A failed create cancels it and leaves the prompt to send by hand.
 */
export function useWorkspaceFirstSend(draftId: DraftId | null, send: () => unknown): void {
  const sendNow = useEffectEvent(send);
  const draft = useComposerDraftStore((state) =>
    draftId === null ? null : state.getDraftSession(draftId),
  );
  const threadId = draft?.threadId ?? null;
  const queued = usePendingFirstSends(
    (state) => threadId !== null && state.threadIds.has(threadId),
  );
  const workspace = useWorkspaceForPath(draft?.environmentId ?? null, draft?.worktreePath ?? null);
  const status = workspace?.status ?? null;

  // oxlint-disable-next-line t3code/react-effect-budget -- The worktree is created on the server, so the streamed status decides when to send.
  useEffect(() => {
    if (threadId === null || !queued) return;
    if (status === "failed") {
      if (takeWorkspaceFirstSend(threadId)) {
        toastManager.add({
          type: "warning",
          title: "Your message was not sent",
          description: "The workspace could not be created. Your message is still in the composer.",
        });
      }
      return;
    }
    if (status !== "ready") return;
    // Lets the composer render the prefilled prompt before ChatView reads it.
    // Taken inside the frame, so a cancelled frame (Strict Mode) still sends later.
    const frame = requestAnimationFrame(() => {
      if (takeWorkspaceFirstSend(threadId)) void sendNow();
    });
    return () => cancelAnimationFrame(frame);
  }, [threadId, queued, status]);
}
