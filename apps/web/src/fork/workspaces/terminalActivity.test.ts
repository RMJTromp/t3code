import type { TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { advanceTerminalRuns, longRunningPaths } from "./terminalActivity";

function summary(overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  return {
    threadId: "thread-1",
    terminalId: "default",
    cwd: "/worktrees/repo/oslo",
    worktreePath: "/worktrees/repo/oslo/",
    status: "running",
    pid: 100,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "sleep",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("advanceTerminalRuns", () => {
  it("keeps a run's first-seen start and reports its duration when the subprocess ends", () => {
    const started = advanceTerminalRuns(new Map(), [summary()], 1_000);
    const still = advanceTerminalRuns(started.running, [summary({ label: "sleep 40" })], 20_000);
    const done = advanceTerminalRuns(
      still.running,
      [summary({ hasRunningSubprocess: false })],
      41_000,
    );

    expect([...still.running.values()]).toEqual([
      { path: "/worktrees/repo/oslo", terminalId: "default", startedAt: 1_000 },
    ]);
    expect(done.running.size).toBe(0);
    expect(done.finished).toEqual([
      { path: "/worktrees/repo/oslo", terminalId: "default", startedAt: 1_000, durationMs: 40_000 },
    ]);
  });

  it("treats a shell exiting mid-run as a finish", () => {
    const started = advanceTerminalRuns(new Map(), [summary()], 0);
    const exited = advanceTerminalRuns(started.running, [summary({ status: "exited" })], 31_000);
    expect(exited.finished.map((run) => run.durationMs)).toEqual([31_000]);
  });

  it("drops a closed terminal without reporting a finish", () => {
    const started = advanceTerminalRuns(new Map(), [summary()], 0);
    const closed = advanceTerminalRuns(started.running, [], 60_000);
    expect(closed.running.size).toBe(0);
    expect(closed.finished).toEqual([]);
  });

  it("ignores idle shells and falls back to cwd without a worktree path", () => {
    const next = advanceTerminalRuns(
      new Map(),
      [
        summary({ terminalId: "idle", hasRunningSubprocess: false }),
        summary({ threadId: "thread-2", worktreePath: null, cwd: "/repo" }),
      ],
      0,
    );
    expect([...next.running.values()].map((run) => run.path)).toEqual(["/repo"]);
    expect(next.finished).toEqual([]);
  });
});

describe("longRunningPaths", () => {
  it("lists paths past five seconds and schedules the next one to cross", () => {
    const { running } = advanceTerminalRuns(
      new Map(),
      [summary({ worktreePath: "/a" }), summary({ threadId: "thread-2", worktreePath: "/b" })],
      0,
    );
    const later = advanceTerminalRuns(
      running,
      [
        summary({ worktreePath: "/a" }),
        summary({ threadId: "thread-2", worktreePath: "/b" }),
        summary({ threadId: "thread-3", worktreePath: "/c" }),
      ],
      3_000,
    );

    expect(longRunningPaths(later.running, 4_000)).toEqual({
      paths: new Set(),
      nextCheckAt: 5_000,
    });
    expect(longRunningPaths(later.running, 5_000)).toEqual({
      paths: new Set(["/a", "/b"]),
      nextCheckAt: 8_000,
    });
    expect(longRunningPaths(later.running, 8_000).paths).toEqual(new Set(["/a", "/b", "/c"]));
  });
});
