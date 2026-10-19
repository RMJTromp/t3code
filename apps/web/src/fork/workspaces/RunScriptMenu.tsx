import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectExtraScript, ThreadId, Workspace } from "@t3tools/contracts";
import { ChevronDownIcon, PlayIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useRightPanelStore } from "../../rightPanelStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { forkWorkspaceEnvironment, useProjectWorkspaceScripts, useWorkspaceForPath } from "./state";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";
import { workspaceAcceptsChats } from "./logic";

/**
 * The right panel's "Run script" menu, in its tab bar and on its empty screen.
 * Renders nothing outside a workspace or when the project has no extra scripts.
 */
export function RunScriptMenu({ variant }: { variant: "tab" | "empty" }) {
  const active = useActiveWorkspaceLocation();
  const workspace = useWorkspaceForPath(active.environmentId, active.worktreePath);
  const { scripts } = useProjectWorkspaceScripts(
    active.environmentId,
    workspace?.projectId ?? null,
  );
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  const runnable = scripts.filter((script) => script.command.trim().length > 0);
  if (
    active.environmentId === null ||
    active.viewedThreadId === null ||
    workspace === null ||
    !workspaceAcceptsChats(workspace) ||
    runnable.length === 0
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

  const items = runnable.map((script) => (
    <MenuItem key={script.id} onClick={() => run(script)}>
      <PlayIcon />
      <span className="min-w-0 truncate">{script.name.trim() || "Untitled script"}</span>
      {isRunning(workspace, script) ? (
        <span className="ml-auto text-primary text-xs">running</span>
      ) : null}
    </MenuItem>
  ));

  if (variant === "tab") {
    return (
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost-muted" className="shrink-0" />}>
          <PlayIcon />
          Run script
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" sideOffset={6}>
          {items}
        </MenuPopup>
      </Menu>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="mt-0.5 flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors hover:bg-accent/60"
          />
        }
      >
        <PlayIcon className="size-4" />
        <span className="min-w-0 flex-1 truncate">Run script</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" sideOffset={6}>
        {items}
      </MenuPopup>
    </Menu>
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
