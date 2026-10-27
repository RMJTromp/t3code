import {
  AuthTerminalReadScope,
  isWorkspaceScriptTerminalId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { hasNotificationSound, playNotificationSound } from "../../threadNotifications";
import { sameWorkspacePath, workspaceForPath } from "./logic";
import { useEnvironmentWorkspaces } from "./state";
import {
  advanceTerminalRuns,
  clearTerminalFinished,
  type FinishedTerminalRun,
  longRunningPaths,
  markTerminalFinished,
  NOTIFY_AFTER_MS,
  setLongRunningPaths,
  type TerminalRun,
} from "./terminalActivity";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";

const soundEnabled = () => hasNotificationSound(getClientSettings().notificationMode);

/** Turns one environment's terminal activity into workspace row state and a finish sound. */
export function TerminalActivityWatcher({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const metadata = useEnvironmentQuery(
    canRead ? terminalEnvironment.metadata({ environmentId, input: null }) : null,
  );
  const summaries = metadata.error === null ? metadata.data : null;
  const workspaces = useEnvironmentWorkspaces(environmentId);
  const active = useActiveWorkspaceLocation();
  const activePath = active.environmentId === environmentId ? active.worktreePath : null;
  const runs = useRef<ReadonlyMap<string, TerminalRun>>(new Map());

  const onFinished = useEffectEvent((run: FinishedTerminalRun) => {
    const workspace = workspaceForPath(workspaces, run.path);
    if (workspace === null || run.durationMs < NOTIFY_AFTER_MS) return;
    const inView = sameWorkspacePath(activePath, workspace.worktreePath);
    if (!inView) markTerminalFinished(environmentId, workspace.worktreePath);
    const away = !inView || document.visibilityState !== "visible" || !document.hasFocus();
    if (away && !isWorkspaceScriptTerminalId(run.terminalId) && soundEnabled()) {
      void playNotificationSound("completion", soundEnabled);
    }
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- Terminal runs end on the server; the streamed metadata and a threshold timer drive the row dot and sound.
  useEffect(() => {
    const next = advanceTerminalRuns(runs.current, summaries ?? [], Date.now());
    runs.current = next.running;
    for (const run of next.finished) onFinished(run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      const { paths, nextCheckAt } = longRunningPaths(runs.current, Date.now());
      setLongRunningPaths(environmentId, paths);
      if (nextCheckAt !== null) timer = setTimeout(sync, nextCheckAt - Date.now());
    };
    sync();
    return () => clearTimeout(timer);
  }, [environmentId, summaries]);

  // oxlint-disable-next-line t3code/react-effect-budget -- A disconnected environment's rows must not keep a stale running dot.
  useEffect(() => () => setLongRunningPaths(environmentId, []), [environmentId]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Opening the workspace, by any route, is what marks its finished run seen.
  useEffect(() => {
    if (activePath !== null) clearTerminalFinished(environmentId, activePath);
  }, [environmentId, activePath]);

  return null;
}
