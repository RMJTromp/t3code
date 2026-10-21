import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Enough for every open tab; a forgotten chat falls back to its server creation time.
const MAX_REMEMBERED = 500;

interface TabOrderState {
  readonly openedAt: Readonly<Record<string, string>>;
  readonly remember: (
    entries: ReadonlyArray<readonly [threadId: string, openedAt: string]>,
  ) => void;
}

/**
 * When each chat's tab opened, as a draft. The server dates a chat from its
 * first message, so without this, sending a draft would move its tab.
 */
export const useWorkspaceTabOrder = create<TabOrderState>()(
  persist(
    (set) => ({
      openedAt: {},
      remember: (entries) =>
        set((state) => {
          const fresh = entries.filter(([threadId]) => state.openedAt[threadId] === undefined);
          if (fresh.length === 0) return state;
          const openedAt = Object.entries({ ...state.openedAt, ...Object.fromEntries(fresh) })
            .toSorted(([, left], [, right]) => right.localeCompare(left))
            .slice(0, MAX_REMEMBERED);
          return { openedAt: Object.fromEntries(openedAt) };
        }),
    }),
    {
      name: "t3fork:workspace-tab-order:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ openedAt: state.openedAt }),
    },
  ),
);
