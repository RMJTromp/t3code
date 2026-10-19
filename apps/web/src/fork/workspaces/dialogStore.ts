import type { EnvironmentId, ProjectId, WorkspaceId } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkspaceTarget {
  readonly environmentId: EnvironmentId;
  readonly workspaceId: WorkspaceId;
}

interface ForkWorkspaceDialogState {
  readonly newWorkspace: {
    readonly environmentId: EnvironmentId | null;
    readonly projectId: ProjectId | null;
  } | null;
  readonly log: WorkspaceTarget | null;
}

export const useForkWorkspaceDialogs = create<ForkWorkspaceDialogState>(() => ({
  newWorkspace: null,
  log: null,
}));

export function openNewWorkspaceDialog(
  preset: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null = null,
): void {
  useForkWorkspaceDialogs.setState({
    newWorkspace: {
      environmentId: preset?.environmentId ?? null,
      projectId: preset?.projectId ?? null,
    },
  });
}

export function openWorkspaceLog(target: WorkspaceTarget): void {
  useForkWorkspaceDialogs.setState({ log: target });
}

export function closeWorkspaceDialog(kind: keyof ForkWorkspaceDialogState): void {
  useForkWorkspaceDialogs.setState({ [kind]: null });
}
