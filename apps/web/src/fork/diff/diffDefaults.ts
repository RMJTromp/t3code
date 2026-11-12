import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { useDiffPanelStore } from "../../diffPanelStore";

/** Every way the diff panel opens lands on uncommitted changes, not the branch range. */
const FORK_DIFF_OPEN_SCOPE = "unstaged" as const;

const EMPTY_KEYS: ReadonlySet<string> = new Set();

// Files the user folded against the default. Storing exceptions rather than upstream's
// full collapsed set means files that appear later still start at the default.
const useFoldExceptions = create<{ byScopeKey: Record<string, ReadonlySet<string>> }>()(() => ({
  byScopeKey: {},
}));

export function foldedKeys(
  fileKeys: ReadonlyArray<string>,
  exceptions: ReadonlySet<string>,
  collapsedByDefault: boolean,
): ReadonlySet<string> {
  return new Set(fileKeys.filter((key) => collapsedByDefault !== exceptions.has(key)));
}

export function foldExceptions(
  fileKeys: ReadonlyArray<string>,
  folded: ReadonlySet<string>,
  collapsedByDefault: boolean,
): ReadonlySet<string> {
  return new Set(fileKeys.filter((key) => folded.has(key) !== collapsedByDefault));
}

export function useForkDiffFolds(
  scopeKey: string | null,
  fileKeys: ReadonlyArray<string>,
  collapsedByDefault: boolean,
) {
  const exceptions = useFoldExceptions((state) =>
    scopeKey ? state.byScopeKey[scopeKey] : undefined,
  );
  const collapsed = foldedKeys(fileKeys, exceptions ?? EMPTY_KEYS, collapsedByDefault);
  const update = (change: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
    if (!scopeKey) return;
    useFoldExceptions.setState((state) => {
      const current = foldedKeys(
        fileKeys,
        state.byScopeKey[scopeKey] ?? EMPTY_KEYS,
        collapsedByDefault,
      );
      const next = change(current);
      if (next === current) return state;
      return {
        byScopeKey: {
          ...state.byScopeKey,
          [scopeKey]: foldExceptions(fileKeys, next, collapsedByDefault),
        },
      };
    });
  };
  return { collapsed, update };
}

/** Opening the diff panel starts every file at the default fold again. */
function forkResetDiffFolds(threadRef: ScopedThreadRef) {
  // Matches DiffPanel's collapseScopeKey: `${environmentId}:${threadId}:${section}`.
  const prefix = `${threadRef.environmentId}:${threadRef.threadId}:`;
  useFoldExceptions.setState((state) => {
    const keys = Object.keys(state.byScopeKey);
    if (!keys.some((key) => key.startsWith(prefix))) return state;
    return {
      byScopeKey: Object.fromEntries(
        Object.entries(state.byScopeKey).filter(([key]) => !key.startsWith(prefix)),
      ),
    };
  });
}

/** An untargeted diff open (toggle, + menu, proactive) lands on uncommitted, files at the default fold. */
export function forkOpenDiffDefaults(threadRef: ScopedThreadRef) {
  forkResetDiffFolds(threadRef);
  useDiffPanelStore.getState().selectGitScope(threadRef, FORK_DIFF_OPEN_SCOPE);
}
