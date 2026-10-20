import { ProjectId, WorkspaceId, type Workspace } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accumulateWorkspaceLog,
  compactRelativeTime,
  formatIssueForPrompt,
  matchHashReferences,
  workspaceLastActivity,
  neighbourAfterClose,
  owningUserChatId,
  routeNewThread,
  threadsForWorkspace,
  unassignedProjectThreads,
  workspaceDraftSlot,
} from "./logic";

const projectId = ProjectId.make("project-1");

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: WorkspaceId.make("ws-oslo"),
    projectId,
    name: "oslo",
    worktreePath: "/worktrees/repo/oslo",
    branch: "oslo",
    baseRef: "main",
    status: "ready",
    pendingOperation: null,
    error: null,
    lastScript: null,
    setupTerminal: null,
    runningScripts: [],
    setupPending: false,
    checkout: { type: "new", startFromOrigin: true },
    createdAt: "2026-10-19T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

const thread = (
  id: string,
  worktreePath: string | null,
  overrides: {
    archivedAt?: string | null;
    createdAt?: string;
    projectId?: ProjectId;
    subagentOf?: string;
  } = {},
) => ({
  id,
  projectId: overrides.projectId ?? projectId,
  worktreePath,
  archivedAt: overrides.archivedAt ?? null,
  createdAt: overrides.createdAt ?? "2026-10-19T00:00:00.000Z",
  lineage: {
    parentThreadId: overrides.subagentOf ?? null,
    relationshipToParent: overrides.subagentOf === undefined ? null : ("subagent" as const),
  },
});

describe("threadsForWorkspace", () => {
  it("matches live project threads in the workspace folder, oldest first", () => {
    const threads = [
      thread("later", "/worktrees/repo/oslo/", { createdAt: "2026-10-19T02:00:00.000Z" }),
      thread("earlier", "/worktrees/repo/oslo", { createdAt: "2026-10-19T01:00:00.000Z" }),
      thread("archived", "/worktrees/repo/oslo", { archivedAt: "2026-10-19T03:00:00.000Z" }),
      thread("other-project", "/worktrees/repo/oslo", { projectId: ProjectId.make("other") }),
      thread("helper", "/worktrees/repo/oslo", { subagentOf: "earlier" }),
      thread("root", "/repo"),
      thread("root-helper", "/repo", { subagentOf: "root" }),
    ];
    expect(threadsForWorkspace(threads, workspace()).map((entry) => entry.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect(unassignedProjectThreads(threads, projectId, [workspace()]).map((t) => t.id)).toEqual([
      "root",
    ]);
  });

  it("finds the user chat behind nested subagents", () => {
    const threads = [
      thread("lead", "/worktrees/repo/oslo"),
      thread("helper", "/worktrees/repo/oslo", { subagentOf: "lead" }),
      thread("helper-of-helper", "/worktrees/repo/oslo", { subagentOf: "helper" }),
      thread("orphan", "/worktrees/repo/oslo", { subagentOf: "missing" }),
    ];
    expect(owningUserChatId(threads, "helper-of-helper")).toBe("lead");
    expect(owningUserChatId(threads, "lead")).toBe("lead");
    expect(owningUserChatId(threads, "orphan")).toBeNull();
  });
});

describe("routeNewThread", () => {
  const base = {
    isScratchProject: false,
    projectId,
    requestedWorktreePath: undefined,
    currentWorktreePath: null,
    workspaces: [workspace()],
  };

  it("keeps projectless chats and unrelated explicit worktrees upstream", () => {
    expect(routeNewThread({ ...base, isScratchProject: true })).toEqual({ kind: "upstream" });
    expect(routeNewThread({ ...base, requestedWorktreePath: "/elsewhere" })).toEqual({
      kind: "upstream",
    });
  });

  it("stays in the workspace being viewed, otherwise asks for one", () => {
    expect(routeNewThread({ ...base, currentWorktreePath: "/worktrees/repo/oslo/" })).toEqual({
      kind: "workspace",
      workspace: workspace(),
    });
    expect(routeNewThread(base)).toEqual({ kind: "choose-workspace" });
    expect(
      routeNewThread({
        ...base,
        currentWorktreePath: "/worktrees/repo/oslo",
        workspaces: [workspace({ status: "archived" })],
      }),
    ).toEqual({ kind: "choose-workspace" });
  });

  it("gives two workspaces in one project separate draft slots", () => {
    expect(workspaceDraftSlot(workspace())).not.toEqual(
      workspaceDraftSlot(workspace({ id: WorkspaceId.make("ws-lima") })),
    );
  });
});

describe("accumulateWorkspaceLog", () => {
  it("restarts on a snapshot and appends otherwise", () => {
    const appended = accumulateWorkspaceLog("$ setup\n", { type: "append", text: "ok\n" });
    expect(appended).toBe("$ setup\nok\n");
    expect(accumulateWorkspaceLog(appended, { type: "snapshot", text: "$ archive\n" })).toBe(
      "$ archive\n",
    );
  });
});

describe("neighbourAfterClose", () => {
  it("moves to the next tab, else the previous, else nowhere", () => {
    expect(neighbourAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterClose(["a"], "a")).toBeNull();
  });
});

describe("workspace activity", () => {
  it("uses the newest turn end, else the creation time", () => {
    const created = { createdAt: "2026-10-19T00:00:00.000Z" };
    const run = (requestedAt: string, completedAt: string | null) => ({
      createdAt: created.createdAt,
      latestRun: { requestedAt, completedAt },
    });
    expect(workspaceLastActivity(created, [])).toBe(created.createdAt);
    expect(
      workspaceLastActivity(created, [
        run("2026-10-19T01:00:00.000Z", "2026-10-19T02:00:00.000Z"),
        run("2026-10-19T04:00:00.000Z", "2026-10-19T05:00:00.000Z"),
      ]),
    ).toBe("2026-10-19T05:00:00.000Z");
  });

  it("holds a working chat at the time its turn was asked for", () => {
    const created = { createdAt: "2026-10-19T00:00:00.000Z" };
    expect(
      workspaceLastActivity(created, [
        {
          createdAt: created.createdAt,
          latestRun: { requestedAt: "2026-10-19T03:00:00.000Z", completedAt: null },
        },
        { createdAt: created.createdAt, latestRun: null },
      ]),
    ).toBe("2026-10-19T03:00:00.000Z");
  });

  it("drops the ago suffix", () => {
    expect(compactRelativeTime("3h ago")).toBe("3h");
    expect(compactRelativeTime("just now")).toBe("now");
  });
});

describe("formatIssueForPrompt", () => {
  const issue = { number: 12, title: "Crash on start", url: "https://example.com/12" };

  it("fences the issue and leaves a blank line to keep typing after", () => {
    expect(formatIssueForPrompt({ ...issue, body: "Steps\n" })).toBe(
      "```md\n## [#12: Crash on start](https://example.com/12)\n\nSteps\n```\n\n",
    );
  });

  it("outgrows the body's own fences", () => {
    const formatted = formatIssueForPrompt({ ...issue, body: "```ts\nboom()\n```" });
    expect(formatted.startsWith("````md\n")).toBe(true);
    expect(formatted.endsWith("\n````\n\n")).toBe(true);
  });
});

describe("matchHashReferences", () => {
  const items = [
    { number: 12, title: "Crash on start" },
    { number: 120, title: "Docs" },
    { number: 3, title: "Login crash" },
  ];

  it("matches a number's start and puts the exact number first", () => {
    expect(matchHashReferences(items, "12", 10).map((item) => item.number)).toEqual([12, 120]);
  });

  it("matches titles otherwise, newest first", () => {
    expect(matchHashReferences(items, "crash", 10).map((item) => item.number)).toEqual([12, 3]);
  });
});
