import { describe, expect, it } from "vite-plus/test";

import { hasBackgroundCommand, isChatWorking } from "./useThreadAttention";

const chat = (
  overrides: {
    runtime?: { status: "running" | "idle" | "preparing" | "ready" } | null;
    blockedOnThreadWait?: boolean;
    pendingBackgroundTasks?: ReadonlyArray<{
      kind: "subagent" | "command" | "monitor" | "background_task";
      awaited?: true;
    }>;
  } = {},
) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    runtime: overrides.runtime ?? null,
    blockedOnThreadWait: overrides.blockedOnThreadWait ?? false,
    pendingBackgroundTasks: (overrides.pendingBackgroundTasks ?? []).map((task, index) => ({
      taskId: `task-${index}`,
      ...task,
    })),
  }) as Parameters<typeof isChatWorking>[0];

describe("chat activity", () => {
  it("counts setup and waiting on a subagent as working", () => {
    expect(isChatWorking(chat({ runtime: { status: "preparing" } }))).toBe(true);
    expect(isChatWorking(chat({ runtime: { status: "running" }, blockedOnThreadWait: true }))).toBe(
      true,
    );
    // The turn ended while a background subagent runs on.
    expect(
      isChatWorking(
        chat({ runtime: { status: "idle" }, pendingBackgroundTasks: [{ kind: "subagent" }] }),
      ),
    ).toBe(true);
  });

  it("shows a background command as running, not as the agent working", () => {
    const awaiting = chat({
      runtime: { status: "idle" },
      pendingBackgroundTasks: [{ kind: "command", awaited: true }],
    });
    expect(isChatWorking(awaiting)).toBe(false);
    expect(hasBackgroundCommand(awaiting)).toBe(true);
    expect(hasBackgroundCommand(chat())).toBe(false);
  });
});
