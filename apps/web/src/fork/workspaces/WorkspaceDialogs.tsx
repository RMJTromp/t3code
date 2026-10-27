import { type EnvironmentId, type WorkspaceId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { closeWorkspaceDialog, useForkWorkspaceDialogs } from "./dialogStore";
import { forkWorkspaceEnvironment, useEnvironmentWorkspaces, useWorkspaceLog } from "./state";
import { useArchiveWorkspace, ArchiveFailureNotifier } from "./useArchiveWorkspace";
import { NewWorkspaceComposer } from "./NewWorkspaceComposer";
import { useConnectedEnvironmentIds } from "../../state/environments";

export function ForkWorkspaceDialogHost() {
  const dialogs = useForkWorkspaceDialogs();
  const environmentIds = useConnectedEnvironmentIds();
  return (
    <>
      {environmentIds.map((environmentId) => (
        <ArchiveFailureNotifier key={environmentId} environmentId={environmentId} />
      ))}
      {dialogs.newWorkspace ? <NewWorkspaceComposer preset={dialogs.newWorkspace} /> : null}
      {dialogs.log ? <WorkspaceLogDialog target={dialogs.log} /> : null}
    </>
  );
}

function WorkspaceLogDialog({
  target,
}: {
  target: { environmentId: EnvironmentId; workspaceId: WorkspaceId };
}) {
  const workspaces = useEnvironmentWorkspaces(target.environmentId);
  const workspace = workspaces.find((entry) => entry.id === target.workspaceId);
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  const archive = useArchiveWorkspace();
  const script = workspace?.lastScript ?? null;
  const archiveScriptFailed =
    workspace?.status === "ready" && script?.kind === "archive" && script.phase === "failed";
  const scriptRunning = script?.phase === "running";
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) closeWorkspaceDialog("log");
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {workspace?.name ?? "Workspace"}
            {script ? ` · ${script.kind} script` : ""}
          </DialogTitle>
          <DialogDescription>
            {workspace === undefined
              ? "This workspace no longer exists."
              : (workspace.error ??
                (script === null
                  ? "No script has run yet."
                  : scriptRunning
                    ? "Running…"
                    : script.phase === "succeeded"
                      ? "Finished."
                      : `Failed${script.exitCode === null ? "" : ` with exit code ${script.exitCode}`}.`))}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <WorkspaceLogView environmentId={target.environmentId} workspaceId={target.workspaceId} />
        </DialogPanel>
        <DialogFooter>
          {workspace?.pendingOperation && workspace.status === "failed" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void command({
                  environmentId: target.environmentId,
                  input: { type: "retry", workspaceId: target.workspaceId },
                })
              }
            >
              Retry
            </Button>
          ) : null}
          {workspace && archiveScriptFailed ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                closeWorkspaceDialog("log");
                void archive(target.environmentId, workspace, workspaces);
              }}
            >
              Archive anyway
            </Button>
          ) : null}
          <Button type="button" onClick={() => closeWorkspaceDialog("log")}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceLogView({
  environmentId,
  workspaceId,
}: {
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
}) {
  const log = useWorkspaceLog(environmentId, workspaceId);
  const ref = useRef<HTMLPreElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Follow new output like a terminal does, before it paints.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && log.length > 0) element.scrollTop = element.scrollHeight;
  }, [log]);
  return (
    <pre
      ref={ref}
      className="max-h-80 min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs"
    >
      {stripAnsi(log) || "No output yet."}
    </pre>
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
