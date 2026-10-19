import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, Workspace } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArchiveIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SidebarChromeFooter, SidebarChromeHeader } from "../../components/sidebar/SidebarChrome";
import { Button } from "../../components/ui/button";
import { SidebarContent, SidebarGroup } from "../../components/ui/sidebar";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useScratchProject } from "../../hooks/useScratchProject";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openNewWorkspaceDialog, openWorkspaceLog } from "./dialogStore";
import {
  compactRelativeTime,
  sameWorkspacePath,
  threadsForWorkspace,
  unassignedProjectThreads,
  workspaceLastActivity,
} from "./logic";
import { useEnvironmentWorkspaces } from "./state";
import { useActiveWorkspaceLocation } from "./useActiveWorkspaceLocation";
import { useArchiveWorkspace } from "./useArchiveWorkspace";
import { useCreateWorkspace, useOpenWorkspace } from "./useOpenWorkspace";
import { type ThreadAttention, useThreadAttention } from "./useThreadAttention";
import { BrailleSpinner } from "./BrailleSpinner";

const EXPANDED_STORAGE_KEY = "t3fork:workspace-sidebar:v1";
const ExpandedSchema = Schema.Record(Schema.String, Schema.Boolean);

/** Spinner while working, else a blue dot when unread. */
function ThreadAttentionMark({ attention }: { attention: ThreadAttention }) {
  if (attention.working) return <BrailleSpinner className="text-xs" />;
  if (attention.unread) {
    return <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />;
  }
  return null;
}

export default function WorkspaceSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { startScratchThread, scratchEnvironmentId } = useScratchProject();
  const active = useActiveWorkspaceLocation();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, {}, ExpandedSchema);
  const toggle = (key: string, fallback: boolean) =>
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? fallback) }));

  const repositories = projects.filter((project) => project.isScratch !== true);
  const looseChats = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        projects.some(
          (project) =>
            project.isScratch === true &&
            project.id === thread.projectId &&
            project.environmentId === thread.environmentId,
        ),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const chatEnvironmentId = scratchEnvironmentId(active.environmentId ?? primaryEnvironmentId);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="min-h-full">
        <SidebarGroup className="flex-1">
          <div className="flex flex-1 flex-col gap-3">
            <div className="flex items-center gap-1 px-1">
              <span className="flex-1 text-sidebar-muted-foreground text-xs font-medium">
                Workspaces
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Add repository"
                title="Add repository"
                onClick={() => openCommandPalette({ open: "add-project" })}
              >
                <FolderPlusIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="New workspace"
                title="New workspace"
                onClick={() =>
                  openNewWorkspaceDialog(
                    active.environmentId && active.projectId
                      ? { environmentId: active.environmentId, projectId: active.projectId }
                      : null,
                  )
                }
              >
                <PlusIcon />
              </Button>
            </div>
            <ul className="flex flex-col gap-1">
              {repositories.map((project) => (
                <ProjectGroup
                  key={`${project.environmentId}:${project.id}`}
                  project={project}
                  threads={threads}
                  active={active}
                  expanded={expanded}
                  onToggle={toggle}
                />
              ))}
              {repositories.length === 0 ? (
                <li className="px-2 py-4 text-center text-muted-foreground/60 text-xs">
                  Add a repository, then create a workspace in it.
                </li>
              ) : null}
            </ul>
            <div className="mt-auto flex flex-col gap-1 border-sidebar-border border-t pt-2">
              <div className="flex items-center gap-1 px-1">
                <span className="flex-1 text-sidebar-muted-foreground text-xs font-medium">
                  Chats
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="New chat"
                  title="New chat without a project"
                  disabled={chatEnvironmentId === null}
                  onClick={() => {
                    if (chatEnvironmentId !== null) void startScratchThread(chatEnvironmentId);
                  }}
                >
                  <PlusIcon />
                </Button>
              </div>
              <ul className="flex flex-col gap-px">
                {looseChats.map((thread) => (
                  <ThreadRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    isActive={active.threadId === thread.id}
                  />
                ))}
                {looseChats.length === 0 ? (
                  <li className="px-2 py-1 text-muted-foreground/60 text-xs">No chats yet</li>
                ) : null}
              </ul>
            </div>
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function ProjectGroup({
  project,
  threads,
  active,
  expanded,
  onToggle,
}: {
  project: EnvironmentProject;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  active: ReturnType<typeof useActiveWorkspaceLocation>;
  expanded: Readonly<Record<string, boolean>>;
  onToggle: (key: string, fallback: boolean) => void;
}) {
  const createWorkspace = useCreateWorkspace();
  const navigate = useNavigate();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const workspaces = useEnvironmentWorkspaces(project.environmentId).filter(
    (workspace) => workspace.projectId === project.id,
  );
  const projectThreads = threads.filter((thread) => thread.environmentId === project.environmentId);
  const live = workspaces
    .filter((workspace) => workspace.status !== "archived")
    .map((workspace) => ({
      workspace,
      lastActivity: workspaceLastActivity(
        workspace,
        threadsForWorkspace(projectThreads, workspace),
      ),
    }))
    .toSorted((left, right) => right.lastActivity.localeCompare(left.lastActivity))
    .map((entry) => entry.workspace);
  const unassigned = unassignedProjectThreads(projectThreads, project.id, workspaces);
  const key = `${project.environmentId}:${project.id}`;
  const isExpanded = expanded[key] ?? true;
  const showUnassigned = expanded[`${key}:unassigned`] ?? false;

  return (
    <li className="flex flex-col">
      <div className="group/project flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-row-hover">
        <button
          type="button"
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-sm"
          aria-expanded={isExpanded}
          onClick={() => onToggle(key, true)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", isExpanded && "rotate-90")}
          />
          <ProjectFavicon project={project} className="size-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">{project.title}</span>
        </button>
        <span className="hidden group-focus-within/project:flex group-hover/project:flex">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Workspace scripts for ${project.title}`}
            onClick={() =>
              void navigate({
                to: "/settings/projects",
                search: {
                  project: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
                  machine: undefined,
                },
                hash: "workspace-scripts",
              })
            }
          >
            <SettingsIcon />
          </Button>
        </span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New workspace in ${project.title}`}
          title="New workspace"
          onClick={() => void createWorkspace(project.environmentId, project.id)}
        >
          <PlusIcon />
        </Button>
      </div>
      {isExpanded ? (
        <ul className="ml-4 flex flex-col gap-px border-sidebar-border border-l pl-1">
          {live.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              environmentId={project.environmentId}
              workspace={workspace}
              members={threadsForWorkspace(projectThreads, workspace)}
              isActive={
                active.environmentId === project.environmentId &&
                sameWorkspacePath(active.worktreePath, workspace.worktreePath)
              }
            />
          ))}
          {live.length === 0 ? (
            <li className="px-2 py-1 text-muted-foreground/60 text-xs">No workspaces</li>
          ) : null}
          {unassigned.length > 0 ? (
            <li className="flex flex-col">
              <ShelfToggle
                label={`Unassigned chats (${unassigned.length})`}
                expanded={showUnassigned}
                onToggle={() => onToggle(`${key}:unassigned`, false)}
              />
              {showUnassigned ? (
                <ul className="flex flex-col gap-px">
                  {unassigned.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      isActive={active.threadId === thread.id}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function ShelfToggle({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-sidebar-muted-foreground text-xs hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    >
      <ChevronRightIcon className={cn("size-3 shrink-0", expanded && "rotate-90")} />
      {label}
    </button>
  );
}

function WorkspaceRow({
  environmentId,
  workspace,
  members,
  isActive,
}: {
  environmentId: EnvironmentId;
  workspace: Workspace;
  members: ReadonlyArray<EnvironmentThreadShell>;
  isActive: boolean;
}) {
  const { open } = useOpenWorkspace();
  const archive = useArchiveWorkspace();
  const siblings = useEnvironmentWorkspaces(environmentId);
  const attentionOf = useThreadAttention();
  const attention = members.map(attentionOf);
  // Creating, archiving, or a running setup or archive script count as busy, like an agent.
  const working =
    attention.some((entry) => entry.working) ||
    workspace.status === "creating" ||
    workspace.status === "archiving" ||
    workspace.lastScript?.phase === "running" ||
    workspace.runningScripts.length > 0;
  const unread = attention.some((entry) => entry.unread);
  const failed = workspace.status === "failed" || workspace.error !== null;
  const target = { environmentId, workspaceId: workspace.id };
  const runningScript = workspace.runningScripts[0];
  const lastActivity = workspaceLastActivity(workspace, members);
  return (
    <li
      className={cn(
        "group/workspace flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-row-hover",
        isActive && "bg-sidebar-row-active",
      )}
    >
      <button
        type="button"
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-sm"
        onClick={() => void open(environmentId, workspace)}
      >
        {working ? (
          <BrailleSpinner className="text-xs" />
        ) : (
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            unread ? "font-medium text-foreground" : "text-sidebar-muted-foreground",
            isActive && "text-foreground",
          )}
        >
          {workspace.branch ?? workspace.name}
        </span>
        {unread ? (
          <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : null}
        {runningScript ? (
          <span className="ml-auto max-w-24 shrink-0 truncate text-primary text-xs group-hover/workspace:hidden">
            {runningScript.name.toLowerCase()}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-muted-foreground/70 text-xs tabular-nums group-hover/workspace:hidden">
            <RelativeTime timestamp={lastActivity} />
          </span>
        )}
      </button>
      {failed ? (
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label={`${workspace.name} needs attention; show script output`}
          onClick={() => openWorkspaceLog(target)}
        >
          <CircleAlertIcon />
        </Button>
      ) : null}
      {/* Takes the time's place on hover rather than reserving room beside it. */}
      <span className="hidden group-focus-within/workspace:flex group-hover/workspace:flex">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Archive ${workspace.name}`}
          disabled={workspace.status === "creating" || workspace.status === "archiving"}
          onClick={() => void archive(environmentId, workspace, siblings)}
        >
          <ArchiveIcon />
        </Button>
      </span>
    </li>
  );
}

/** Only this label re-renders on the minute tick, as in upstream's sidebar. */
function RelativeTime({ timestamp }: { timestamp: string }) {
  const nowMinute = useNowMinute();
  return compactRelativeTime(
    formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`)),
  );
}

function ThreadRow({ thread, isActive }: { thread: EnvironmentThreadShell; isActive: boolean }) {
  const navigate = useNavigate();
  const attentionOf = useThreadAttention();
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-sidebar-row-hover",
          isActive && "bg-sidebar-row-active",
        )}
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          })
        }
      >
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <ThreadAttentionMark attention={attentionOf(thread)} />
      </button>
    </li>
  );
}
