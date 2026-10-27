import type {
  EnvironmentId,
  ProjectId,
  WorkspaceIssue,
  WorkspacePullRequest,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { useAtomCommand } from "../../state/use-atom-command";
import { forkWorkspaceEnvironment } from "./state";

function failureMessage(cause: unknown): string {
  return typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : "The GitHub CLI could not be reached.";
}

interface GhListItems {
  readonly issues: WorkspaceIssue;
  readonly pullRequests: WorkspacePullRequest;
}
type GhListKind = keyof GhListItems;
interface GhListAnswer<K extends GhListKind> {
  readonly items: ReadonlyArray<GhListItems[K]>;
  readonly error: string | null;
}

// Kept across dialog openings: the CLI takes a second or two, so a reopened
// dialog shows the last answer at once and refreshes it in the background.
// A store, not a plain Map: the React Compiler memoizes reads of untracked
// module state, so an answer landing in a Map would never re-render the list.
const useGhListCache = create<{
  readonly answers: Readonly<Record<string, GhListAnswer<GhListKind>>>;
}>(() => ({ answers: {} }));
const ghListKey = (
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  kind: GhListKind,
  query: string,
) => JSON.stringify([environmentId, projectId, kind, query]);

const matchesQuery = (item: { number: number; title: string }, query: string) =>
  `#${item.number} ${item.title}`.toLowerCase().includes(query.toLowerCase());

/**
 * Open issues or pull requests from the server's GitHub CLI. Fetched while
 * `enabled`, which callers set as soon as the dialog opens so a tab is ready
 * when picked. While a search is in flight, the unsearched list is filtered here.
 */
export function useGhList<K extends GhListKind>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly kind: K;
  readonly query: string;
  readonly enabled: boolean;
}) {
  const { environmentId, projectId, kind, query } = input;
  const enabled = input.enabled && environmentId !== null && projectId !== null;
  const command = useAtomCommand(forkWorkspaceEnvironment.command, { reportFailure: false });
  const key = ghListKey(environmentId, projectId, kind, query);
  const answer = useGhListCache((state) => state.answers[key]) as GhListAnswer<K> | undefined;
  const unsearched = useGhListCache(
    (state) => state.answers[ghListKey(environmentId, projectId, kind, "")],
  ) as GhListAnswer<K> | undefined;

  // The command function is new each render; only the inputs should refetch.
  const list = useEffectEvent((commandInput: Parameters<typeof command>[0]) =>
    command(commandInput),
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- Fetches from gh on the server whenever the list inputs change.
  useEffect(() => {
    if (!enabled || environmentId === null || projectId === null) return;
    void list({
      environmentId,
      input: {
        type: kind === "issues" ? "listIssues" : "listPullRequests",
        projectId,
        ...(query.length > 0 ? { query } : {}),
      },
    }).then((result) => {
      if (isAtomCommandInterrupted(result)) return;
      const next: GhListAnswer<GhListKind> =
        result._tag === "Success"
          ? {
              items: (kind === "issues" ? result.value.issues : result.value.pullRequests) ?? [],
              error: null,
            }
          : { items: [], error: failureMessage(squashAtomCommandFailure(result)) };
      useGhListCache.setState(({ answers }) => ({ answers: { ...answers, [key]: next } }));
    });
  }, [enabled, environmentId, key, kind, projectId, query]);

  if (answer !== undefined) return { ...answer, isPending: false };
  return {
    items: (unsearched?.items ?? []).filter((item) => matchesQuery(item, query)),
    error: unsearched?.error ?? null,
    isPending: enabled,
  };
}

/** The issue as the first message's context: its title, link, and body. */
export function useReadIssue() {
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  return async (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    number: number,
  ): Promise<WorkspaceIssue | null> => {
    const result = await command({
      environmentId,
      input: { type: "readIssue", projectId, number },
    });
    return result._tag === "Success" ? (result.value.issues?.[0] ?? null) : null;
  };
}
