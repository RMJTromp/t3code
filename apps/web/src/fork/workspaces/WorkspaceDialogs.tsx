import {
  type EnvironmentId,
  type ProjectId,
  type WorkspaceError,
  type WorkspaceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ProjectFavicon } from "../../components/ProjectFavicon";
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
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { closeWorkspaceDialog, openWorkspaceLog, useForkWorkspaceDialogs } from "./dialogStore";
import { forkWorkspaceEnvironment, useEnvironmentWorkspaces, useWorkspaceLog } from "./state";
import { sameWorkspacePath, workspaceAcceptsChats } from "./logic";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";
import { useCreateWorkspace, useOpenWorkspace } from "./useOpenWorkspace";

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Something went wrong.";
}

function asWorkspaceError(cause: unknown): WorkspaceError | null {
  return typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "WorkspaceError"
    ? (cause as WorkspaceError)
    : null;
}

export function ForkWorkspaceDialogHost() {
  const dialogs = useForkWorkspaceDialogs();
  return (
    <>
      {dialogs.newWorkspace ? <NewWorkspaceDialog preset={dialogs.newWorkspace} /> : null}
      {dialogs.archive ? <ArchiveWorkspaceDialog target={dialogs.archive} /> : null}
      {dialogs.log ? <WorkspaceLogDialog target={dialogs.log} /> : null}
    </>
  );
}

function NewWorkspaceDialog({
  preset,
}: {
  preset: { environmentId: EnvironmentId | null; projectId: ProjectId | null };
}) {
  const projects = useProjects().filter((project) => project.isScratch !== true);
  const [selectedKey, setSelectedKey] = useState(() =>
    preset.environmentId && preset.projectId ? `${preset.environmentId}:${preset.projectId}` : null,
  );
  const selected =
    projects.find((project) => `${project.environmentId}:${project.id}` === selectedKey) ??
    (projects.length === 1 ? projects[0] : undefined);
  const [creating, setCreating] = useState(false);
  const createWorkspace = useCreateWorkspace();

  // Opens the workspace's first chat at once; setup streams into its terminal.
  const submit = async () => {
    if (!selected) return;
    setCreating(true);
    const workspace = await createWorkspace(selected.environmentId, selected.id);
    setCreating(false);
    if (workspace !== null) closeWorkspaceDialog("newWorkspace");
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) closeWorkspaceDialog("newWorkspace");
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A fresh worktree on its own branch, named after a city. Its setup script runs first.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1">
            {projects.length === 0 ? (
              <p className="text-muted-foreground text-sm">Add a repository to get started.</p>
            ) : null}
            {projects.map((project) => {
              const key = `${project.environmentId}:${project.id}`;
              const isSelected =
                selected !== undefined && key === `${selected.environmentId}:${selected.id}`;
              return (
                <Button
                  key={key}
                  type="button"
                  variant={isSelected ? "secondary" : "ghost"}
                  className="justify-start"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedKey(key)}
                >
                  <ProjectFavicon project={project} className="size-4" />
                  <span className="min-w-0 flex-1 truncate text-left">{project.title}</span>
                  {isSelected ? <CheckIcon className="size-4" /> : null}
                </Button>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              closeWorkspaceDialog("newWorkspace");
              openCommandPalette({ open: "add-project" });
            }}
          >
            Add repository…
          </Button>
          <Button type="button" disabled={!selected || creating} onClick={() => void submit()}>
            Create workspace
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ArchiveWorkspaceDialog({
  target,
}: {
  target: { environmentId: EnvironmentId; workspaceId: WorkspaceId };
}) {
  const workspaces = useEnvironmentWorkspaces(target.environmentId);
  const workspace = workspaces.find((entry) => entry.id === target.workspaceId);
  const active = useActiveWorkspaceLocation();
  const viewingThisWorkspace =
    workspace !== undefined &&
    active.environmentId === target.environmentId &&
    sameWorkspacePath(active.worktreePath, workspace.worktreePath);
  const { open } = useOpenWorkspace();
  const archive = useAtomCommand(forkWorkspaceEnvironment.archive, { reportFailure: false });
  const [problem, setProblem] = useState<WorkspaceError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scriptFailed =
    workspace?.status === "ready" &&
    workspace.lastScript?.kind === "archive" &&
    workspace.lastScript.phase === "failed";

  const submit = async (discardChanges: boolean) => {
    setError(null);
    const result = await archive({
      environmentId: target.environmentId,
      input: {
        workspaceId: target.workspaceId,
        ...(discardChanges ? { discardChanges: true } : {}),
        ...(scriptFailed ? { ignoreScriptFailure: true } : {}),
      },
    });
    if (result._tag === "Success") {
      closeWorkspaceDialog("archive");
      openWorkspaceLog(target);
      // Its chats are about to close; stay in the same repository rather than
      // letting upstream fall back to whichever project was used last.
      const sibling = viewingThisWorkspace
        ? workspaces.find(
            (entry) =>
              entry.id !== target.workspaceId &&
              entry.projectId === workspace?.projectId &&
              workspaceAcceptsChats(entry),
          )
        : undefined;
      if (sibling) void open(target.environmentId, sibling);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    const workspaceError = asWorkspaceError(cause);
    if (workspaceError) setProblem(workspaceError);
    else setError(failureMessage(cause));
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) closeWorkspaceDialog("archive");
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive {workspace?.name ?? "workspace"}?</DialogTitle>
          <DialogDescription>
            Runs the archive script, archives this workspace's chats, and removes its folder. The
            branch is kept, so you can restore it later.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2 text-sm">
            {problem?.reason === "agents-running" ? (
              <p role="alert" className="text-destructive">
                {problem.message}
              </p>
            ) : null}
            {problem?.reason === "uncommitted-changes" ? (
              <>
                <p role="alert" className="text-destructive">
                  {problem.message}
                </p>
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
                  {(problem.changedFiles ?? []).join("\n")}
                </pre>
              </>
            ) : null}
            {scriptFailed ? (
              <p role="alert" className="text-destructive">
                The archive script failed (exit code {workspace?.lastScript?.exitCode ?? "unknown"}
                ).
              </p>
            ) : null}
            {problem &&
            problem.reason !== "agents-running" &&
            problem.reason !== "uncommitted-changes" ? (
              <p role="alert" className="text-destructive">
                {problem.message}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => closeWorkspaceDialog("archive")}>
            Cancel
          </Button>
          {problem?.reason === "uncommitted-changes" ? (
            <Button type="button" variant="destructive" onClick={() => void submit(true)}>
              Discard and archive
            </Button>
          ) : scriptFailed ? (
            <Button type="button" variant="destructive" onClick={() => void submit(false)}>
              Archive anyway
            </Button>
          ) : (
            <Button type="button" onClick={() => void submit(false)}>
              Archive
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceLogDialog({
  target,
}: {
  target: { environmentId: EnvironmentId; workspaceId: WorkspaceId };
}) {
  const workspace = useEnvironmentWorkspaces(target.environmentId).find(
    (entry) => entry.id === target.workspaceId,
  );
  const retry = useAtomCommand(forkWorkspaceEnvironment.retry);
  const script = workspace?.lastScript ?? null;
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
                void retry({
                  environmentId: target.environmentId,
                  input: { workspaceId: target.workspaceId },
                })
              }
            >
              Retry
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
  useLayoutEffect(() => {
    const element = ref.current;
    // Follow new output like a terminal does.
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
  // oxlint-disable-next-line no-control-regex -- removing terminal escapes is the point.
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
