import {
  normalizeWorkspacePath,
  type EnvironmentId,
  type TerminalSummary,
} from "@t3tools/contracts";
import { create } from "zustand";

const LONG_RUNNING_AFTER_MS = 5_000;
export const NOTIFY_AFTER_MS = 30_000;

export interface TerminalRun {
  readonly path: string;
  readonly terminalId: string;
  /** Client clock when the subprocess was first seen; a run in progress at load counts from load. */
  readonly startedAt: number;
}

export interface FinishedTerminalRun extends TerminalRun {
  readonly durationMs: number;
}

function runKey(summary: Pick<TerminalSummary, "threadId" | "terminalId">): string {
  return `${summary.threadId}\u0000${summary.terminalId}`;
}

/** A terminal that disappears stops silently; one whose subprocess ends has finished. */
export function advanceTerminalRuns(
  previous: ReadonlyMap<string, TerminalRun>,
  summaries: ReadonlyArray<TerminalSummary>,
  now: number,
): { running: ReadonlyMap<string, TerminalRun>; finished: ReadonlyArray<FinishedTerminalRun> } {
  const running = new Map<string, TerminalRun>();
  const finished: Array<FinishedTerminalRun> = [];
  for (const summary of summaries) {
    const key = runKey(summary);
    const before = previous.get(key);
    if (summary.status === "running" && summary.hasRunningSubprocess) {
      running.set(
        key,
        before ?? {
          path: normalizeWorkspacePath(summary.worktreePath ?? summary.cwd),
          terminalId: summary.terminalId,
          startedAt: now,
        },
      );
    } else if (before) {
      finished.push({ ...before, durationMs: now - before.startedAt });
    }
  }
  return { running, finished };
}

/** Paths with a run past the threshold, and when the next run will cross it. */
export function longRunningPaths(
  running: ReadonlyMap<string, TerminalRun>,
  now: number,
): { paths: ReadonlySet<string>; nextCheckAt: number | null } {
  const paths = new Set<string>();
  let nextCheckAt: number | null = null;
  for (const run of running.values()) {
    const crossesAt = run.startedAt + LONG_RUNNING_AFTER_MS;
    if (crossesAt <= now) paths.add(run.path);
    else nextCheckAt = Math.min(nextCheckAt ?? crossesAt, crossesAt);
  }
  return { paths, nextCheckAt };
}

const workspaceKey = (environmentId: EnvironmentId, path: string) =>
  `${environmentId}\u0000${normalizeWorkspacePath(path)}`;

interface TerminalActivityState {
  readonly longRunning: Readonly<Record<string, true>>;
  /** Finished while the user was elsewhere; in memory only. */
  readonly finishedUnseen: Readonly<Record<string, true>>;
}

const useTerminalActivity = create<TerminalActivityState>(() => ({
  longRunning: {},
  finishedUnseen: {},
}));

export function setLongRunningPaths(environmentId: EnvironmentId, paths: Iterable<string>): void {
  const { longRunning } = useTerminalActivity.getState();
  const prefix = `${environmentId}\u0000`;
  const next: Record<string, true> = {};
  for (const [key, value] of Object.entries(longRunning)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }
  for (const path of paths) next[workspaceKey(environmentId, path)] = true;
  const keys = Object.keys(next);
  if (keys.length === Object.keys(longRunning).length && keys.every((key) => longRunning[key])) {
    return;
  }
  useTerminalActivity.setState({ longRunning: next });
}

export function markTerminalFinished(environmentId: EnvironmentId, path: string): void {
  const key = workspaceKey(environmentId, path);
  useTerminalActivity.setState((state) =>
    state.finishedUnseen[key]
      ? state
      : { finishedUnseen: { ...state.finishedUnseen, [key]: true } },
  );
}

export function clearTerminalFinished(environmentId: EnvironmentId, path: string): void {
  const key = workspaceKey(environmentId, path);
  useTerminalActivity.setState((state) => {
    if (!state.finishedUnseen[key]) return state;
    const { [key]: _seen, ...rest } = state.finishedUnseen;
    return { finishedUnseen: rest };
  });
}

export function useWorkspaceTerminalActivity(environmentId: EnvironmentId, path: string) {
  const key = workspaceKey(environmentId, path);
  const longRunning = useTerminalActivity((state) => state.longRunning[key] === true);
  const finished = useTerminalActivity((state) => state.finishedUnseen[key] === true);
  return { longRunning, finished };
}
