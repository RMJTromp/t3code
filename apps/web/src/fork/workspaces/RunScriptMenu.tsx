import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectExtraScript, ThreadId, Workspace } from "@t3tools/contracts";
import { ChevronDownIcon, PlayIcon, PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { type ReactNode, useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useRightPanelStore } from "../../rightPanelStore";
import { readProject } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { forkWorkspaceEnvironment, useProjectWorkspaceScripts, useWorkspaceForPath } from "./state";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";
import { workspaceAcceptsChats } from "./logic";

/**
 * The right panel's "Run script" menu: a submenu of the tab bar's "+" menu, and a
 * row on its empty screen.
 * Renders nothing outside a workspace.
 */
export function RunScriptMenu({ variant }: { variant: "submenu" | "empty" }) {
  const active = useActiveWorkspaceLocation();
  const workspace = useWorkspaceForPath(active.environmentId, active.worktreePath);
  const { scripts } = useProjectWorkspaceScripts(
    active.environmentId,
    workspace?.projectId ?? null,
  );
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  const navigate = useNavigate();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const runnable = scripts.filter((script) => script.command.trim().length > 0);
  if (
    active.environmentId === null ||
    active.viewedThreadId === null ||
    workspace === null ||
    !workspaceAcceptsChats(workspace)
  ) {
    return null;
  }
  const environmentId = active.environmentId;
  const threadId = active.viewedThreadId;

  const run = (script: ProjectExtraScript) => {
    const running = workspace.runningScripts.find((entry) => entry.scriptId === script.id);
    // Already running: show its terminal rather than typing into a busy one.
    if (running) {
      showScriptTerminal(environmentId, running.threadId, running.terminalId);
      return;
    }
    void command({
      environmentId,
      input: { type: "runScript", workspaceId: workspace.id, scriptId: script.id, threadId },
    });
  };

  const openScriptSettings = () => {
    const project = readProject(scopeProjectRef(environmentId, workspace.projectId));
    if (project === null) return;
    void navigate({
      to: "/settings/projects",
      search: {
        project: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
        machine: undefined,
      },
      hash: "workspace-scripts",
    });
  };

  const addScriptItem = (
    <MenuItem onClick={openScriptSettings}>
      <PlusIcon />
      Add a script…
    </MenuItem>
  );
  const scriptItems = runnable.map((script) => (
    <MenuItem key={script.id} onClick={() => run(script)}>
      <PlayIcon />
      <span className="min-w-0 truncate">{script.name.trim() || "Untitled script"}</span>
      {isRunning(workspace, script) ? (
        <span className="ml-auto text-primary text-xs">running</span>
      ) : null}
    </MenuItem>
  ));
  const items = runnable.length === 0 ? addScriptItem : scriptItems;

  if (variant === "submenu") {
    return (
      <MenuSub>
        <MenuSubTrigger>
          <PlayIcon />
          Run script
        </MenuSubTrigger>
        <MenuSubPopup className="max-w-56">{items}</MenuSubPopup>
      </MenuSub>
    );
  }
  return <EmptyScreenRow items={items} />;
}

/** Mirrors the Browser row on upstream's empty screen: the row opens the menu under its chevron. */
function EmptyScreenRow({ items }: { items: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60"
      >
        <PlayIcon className="size-4" />
        <span className="min-w-0 flex-1 truncate pr-7">Run script</span>
      </button>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <Button
              aria-label="Choose a script"
              className="absolute top-1/2 right-8 -translate-y-1/2"
              size="icon-xs"
              variant="ghost-muted"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
          {items}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function isRunning(workspace: Workspace, script: ProjectExtraScript): boolean {
  return workspace.runningScripts.some((entry) => entry.scriptId === script.id);
}

export function showScriptTerminal(
  environmentId: Parameters<typeof scopeThreadRef>[0],
  threadId: ThreadId,
  terminalId: string,
) {
  useRightPanelStore.getState().openTerminal(scopeThreadRef(environmentId, threadId), terminalId);
}
