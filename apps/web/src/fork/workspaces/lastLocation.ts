import type { ThreadId, WorkspaceId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "../../composerDraftStore";

export type WorkspaceLocation =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "draft"; readonly draftId: DraftId };

interface LastLocationState {
  readonly byWorkspace: Readonly<Record<string, WorkspaceLocation>>;
  readonly remember: (workspaceId: WorkspaceId, location: WorkspaceLocation) => void;
}

/** Reopening a workspace returns to the chat or draft the user left, like Conductor. */
export const useWorkspaceLastLocation = create<LastLocationState>()(
  persist(
    (set) => ({
      byWorkspace: {},
      remember: (workspaceId, location) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId];
          const unchanged =
            current?.kind === location.kind &&
            (current.kind === "thread"
              ? location.kind === "thread" && current.threadId === location.threadId
              : location.kind === "draft" && current.draftId === location.draftId);
          return unchanged
            ? state
            : { byWorkspace: { ...state.byWorkspace, [workspaceId]: location } };
        }),
    }),
    {
      name: "t3fork:workspace-last-location:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byWorkspace: state.byWorkspace }),
    },
  ),
);
