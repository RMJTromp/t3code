import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../../components/Sidebar.logic";
import { useUiStateStore } from "../../uiStateStore";

export interface ThreadAttention {
  readonly working: boolean;
  readonly unread: boolean;
  /** A command or monitor the agent left running in the background, such as one it awaits. */
  readonly commandRunning: boolean;
}

type ActivityInput = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Pick<EnvironmentThreadShell, "pendingBackgroundTasks">;

/**
 * A turn, its setup, or a subagent still running. Upstream calls a turn blocked on a
 * subagent, or a thread parked on a background subagent, "waiting"; here that is working.
 */
export function isChatWorking(thread: ActivityInput): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return (
    status === "working" ||
    status === "preparing" ||
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    thread.pendingBackgroundTasks.some(
      (task) => task.kind === "subagent" || task.kind === "background_task",
    )
  );
}

export function hasBackgroundCommand(thread: ActivityInput): boolean {
  return thread.pendingBackgroundTasks.some(
    (task) => task.kind === "command" || task.kind === "monitor",
  );
}

/** Upstream's unread; working and commands also count the chat's own subagents. */
export function useThreadAttention() {
  const localVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  return (
    thread: EnvironmentThreadShell,
    subagents: ReadonlyArray<EnvironmentThreadShell> = [],
  ): ThreadAttention => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const family = [thread, ...subagents];
    return {
      working: family.some(isChatWorking),
      unread: hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisited[key]),
      }),
      commandRunning: family.some(hasBackgroundCommand),
    };
  };
}
