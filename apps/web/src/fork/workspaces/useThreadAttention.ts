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
}

/** Working and unread exactly as upstream's sidebar decides them. */
export function useThreadAttention() {
  const localVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  return (thread: EnvironmentThreadShell): ThreadAttention => {
    const status = resolveSidebarThreadStatus(thread);
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return {
      working: status === "working",
      unread: hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisited[key]),
      }),
    };
  };
}
