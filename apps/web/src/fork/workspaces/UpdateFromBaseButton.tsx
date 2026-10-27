import type { EnvironmentId, Workspace, WorkspaceError } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ArrowDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { queueWorkspaceFirstSend } from "./firstSend";
import { forkWorkspaceEnvironment } from "./state";
import { useOpenWorkspace } from "./useOpenWorkspace";

const asWorkspaceError = (cause: unknown): WorkspaceError | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "WorkspaceError"
    ? (cause as WorkspaceError)
    : null;

const mergePrompt = (baseRef: string) =>
  [
    `Merge the latest \`origin/${baseRef}\` into this branch: run \`git fetch origin ${baseRef}\`, then \`git merge origin/${baseRef}\`.`,
    "Resolve every conflict so both sides' changes keep working, and keep any uncommitted work.",
    "Run the checks that cover the conflicted files, then commit the merge.",
  ].join("\n");

/**
 * Merges origin's latest target branch into the workspace. A merge that conflicts is undone on
 * the server and handed to an agent in a new chat of the workspace.
 */
function useUpdateFromBase() {
  const command = useAtomCommand(forkWorkspaceEnvironment.command, { reportFailure: false });
  const { newChat } = useOpenWorkspace();
  return async (environmentId: EnvironmentId, workspace: Workspace) => {
    const baseRef = workspace.baseRef ?? "the target branch";
    const result = await command({
      environmentId,
      input: { type: "updateFromBase", workspaceId: workspace.id },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag !== "Success") {
      const error = asWorkspaceError(squashAtomCommandFailure(result));
      toastManager.add({
        type: error?.reason === "agents-running" ? "warning" : "error",
        title: `Couldn't update ${workspace.name}`,
        description: error?.message,
      });
      return;
    }
    if (result.value.update === "up-to-date") {
      toastManager.add({ type: "info", title: `${workspace.name} is up to date` });
      return;
    }
    if (result.value.update === "updated") {
      toastManager.add({
        type: "success",
        title: `Merged origin/${baseRef} into ${workspace.name}`,
      });
      return;
    }
    const opened = await newChat(environmentId, workspace);
    if (opened === null) return;
    useComposerDraftStore.getState().setPrompt(opened.draftId, mergePrompt(baseRef));
    queueWorkspaceFirstSend(opened.threadId);
    toastManager.add({
      type: "info",
      title: `origin/${baseRef} conflicts with ${workspace.name}`,
      description: "An agent is merging it in a new chat.",
    });
  };
}

/** Shows how far the branch trails origin's target branch; a click merges it in. */
export function UpdateFromBaseButton({
  environmentId,
  workspace,
}: {
  environmentId: EnvironmentId;
  workspace: Workspace;
}) {
  const updateFromBase = useUpdateFromBase();
  const [updating, setUpdating] = useState(false);
  const behindBy = workspace.behindBy ?? 0;
  if (behindBy === 0 || workspace.status !== "ready") return null;
  const label = `${behindBy} ${behindBy === 1 ? "commit" : "commits"} behind origin/${workspace.baseRef}. Click to merge them in.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="micro"
            variant="ghost-muted"
            aria-label={label}
            disabled={updating}
            onClick={async () => {
              setUpdating(true);
              await updateFromBase(environmentId, workspace);
              setUpdating(false);
            }}
          />
        }
      >
        <ArrowDownIcon />
        <span className="tabular-nums">{behindBy}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
