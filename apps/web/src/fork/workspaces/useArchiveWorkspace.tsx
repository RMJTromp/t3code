import type { EnvironmentId, Workspace, WorkspaceError } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { toastManager } from "../../components/ui/toast";
import { stackedThreadToast } from "../../components/ui/toastHelpers";
import { useAtomCommand } from "../../state/use-atom-command";
import { openWorkspaceLog } from "./dialogStore";
import { sameWorkspacePath, workspaceAcceptsChats } from "./logic";
import { forkWorkspaceEnvironment, useEnvironmentWorkspaces } from "./state";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";
import { useOpenWorkspace } from "./useOpenWorkspace";

function asWorkspaceError(cause: unknown): WorkspaceError | null {
  return typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "WorkspaceError"
    ? (cause as WorkspaceError)
    : null;
}

/**
 * Archives without asking. The script runs in the background; only a refusal
 * or a failure surfaces, as a toast.
 */
export function useArchiveWorkspace() {
  const command = useAtomCommand(forkWorkspaceEnvironment.command, { reportFailure: false });
  const active = useActiveWorkspaceLocation();
  const { open } = useOpenWorkspace();

  const archive = async (
    environmentId: EnvironmentId,
    workspace: Workspace,
    siblings: ReadonlyArray<Workspace>,
    options: { discardChanges?: boolean } = {},
  ): Promise<void> => {
    const scriptFailed =
      workspace.lastScript?.kind === "archive" && workspace.lastScript.phase === "failed";
    const result = await command({
      environmentId,
      input: {
        type: "archive",
        workspaceId: workspace.id,
        ...(options.discardChanges ? { discardChanges: true } : {}),
        // Archiving again after a failed archive script means "archive anyway".
        ...(scriptFailed ? { ignoreScriptFailure: true } : {}),
      },
    });
    if (result._tag === "Success") {
      // Its chats are about to close; stay in the same repository.
      const viewing =
        active.environmentId === environmentId &&
        sameWorkspacePath(active.worktreePath, workspace.worktreePath);
      const sibling = viewing
        ? siblings.find(
            (entry) =>
              entry.id !== workspace.id &&
              entry.projectId === workspace.projectId &&
              workspaceAcceptsChats(entry),
          )
        : undefined;
      if (sibling) void open(environmentId, sibling);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    const error = asWorkspaceError(cause);
    if (error?.reason === "uncommitted-changes") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${workspace.name} has uncommitted changes`,
          description: (error.changedFiles ?? []).slice(0, 5).join("\n"),
          actionVariant: "destructive",
          actionProps: {
            children: "Discard and archive",
            onClick: () =>
              void archive(environmentId, workspace, siblings, { discardChanges: true }),
          },
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: error?.reason === "agents-running" ? "warning" : "error",
        title: `Couldn't archive ${workspace.name}`,
        description: error?.message ?? (cause instanceof Error ? cause.message : undefined),
      }),
    );
  };

  return archive;
}

/** Toasts when a background archive ends without archiving, with a way to the output. */
export function ArchiveFailureNotifier({ environmentId }: { environmentId: EnvironmentId }) {
  const workspaces = useEnvironmentWorkspaces(environmentId);
  const previous = useRef(new Map<string, Workspace["status"]>());
  // oxlint-disable-next-line t3code/react-effect-budget -- An archive ends on the server, so only the streamed status change can raise its toast.
  useEffect(() => {
    const seen = previous.current;
    for (const workspace of workspaces) {
      const before = seen.get(workspace.id);
      if (
        before === "archiving" &&
        workspace.status !== "archiving" &&
        workspace.status !== "archived"
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Couldn't archive ${workspace.name}`,
            description: workspace.error ?? "The archive script failed.",
            actionProps: {
              children: "Show output",
              onClick: () => openWorkspaceLog({ environmentId, workspaceId: workspace.id }),
            },
          }),
        );
      }
    }
    previous.current = new Map(workspaces.map((workspace) => [workspace.id, workspace.status]));
  }, [environmentId, workspaces]);
  return null;
}
