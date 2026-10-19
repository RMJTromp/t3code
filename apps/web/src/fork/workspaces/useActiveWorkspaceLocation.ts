import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useThreadShell } from "../../state/entities";

/** Where the open chat or draft runs, so workspace UI can tell which one is in view. */
export function useActiveWorkspaceLocation() {
  const target = useThreadRouteTarget();
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const source = thread ?? draft;
  return {
    environmentId: source?.environmentId ?? null,
    projectId: source?.projectId ?? null,
    worktreePath: source?.worktreePath ?? null,
    threadId: target?.kind === "server" ? target.threadRef.threadId : null,
    /** The chat in view, sent or draft; its right panel hosts script terminals. */
    viewedThreadId:
      target?.kind === "server" ? target.threadRef.threadId : (draft?.threadId ?? null),
  };
}
