import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  WorkspaceCommand,
  WorkspaceIssue,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef } from "@t3tools/shared/git";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ChevronDownIcon, FolderPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../../components/chat/runtimeModeConfig";
import { TraitsPicker } from "../../components/chat/TraitsPicker";
import { Button } from "../../components/ui/button";
import { Dialog, DialogPopup } from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { usePaginatedBranches } from "../../state/queries";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { type CheckoutChoice, CheckoutPicker } from "./CheckoutPicker";
import { useReadIssue } from "./github";
import { formatIssueForPrompt } from "./logic";
import { TargetBranchPicker } from "./TargetBranchPicker";
import { closeWorkspaceDialog } from "./dialogStore";
import { useCreateWorkspace } from "./useOpenWorkspace";

type Project = ReturnType<typeof useProjects>[number];

const projectKey = (project: { environmentId: EnvironmentId; id: ProjectId }) =>
  `${project.environmentId}:${project.id}`;

/**
 * The new-workspace dialog, shaped like the chat composer: what to work on,
 * where it branches from or what it checks out, and the first chat's model.
 */
export function NewWorkspaceComposer({
  preset,
}: {
  preset: { environmentId: EnvironmentId | null; projectId: ProjectId | null };
}) {
  const projects = useProjects().filter((project) => project.isScratch !== true);
  const [selectedKey, setSelectedKey] = useState(() =>
    preset.environmentId && preset.projectId
      ? projectKey({ environmentId: preset.environmentId, id: preset.projectId })
      : null,
  );
  const project =
    projects.find((candidate) => projectKey(candidate) === selectedKey) ??
    (projects.length === 1 ? projects[0] : undefined);
  const close = () => closeWorkspaceDialog("newWorkspace");

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
    >
      <DialogPopup aria-label="New workspace" showCloseButton={false} className="sm:max-w-2xl">
        {project ? (
          // Keyed so branch, checkout, and model choices reset with the project.
          <ProjectComposer
            key={projectKey(project)}
            project={project}
            projects={projects}
            onProjectChange={(next) => setSelectedKey(projectKey(next))}
            onCreated={close}
          />
        ) : (
          <div className="flex flex-col items-start gap-3 p-4">
            <ProjectMenu
              projects={projects}
              project={undefined}
              onChange={(next) => setSelectedKey(projectKey(next))}
            />
            <p className="text-muted-foreground text-sm">
              {projects.length === 0
                ? "Add a repository to create a workspace in it."
                : "Choose the repository for this workspace."}
            </p>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectMenu({
  projects,
  project,
  onChange,
}: {
  projects: ReadonlyArray<Project>;
  project: Project | undefined;
  onChange: (project: Project) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="xs" />}>
        {project ? <ProjectFavicon project={project} className="size-4" /> : null}
        <span className="max-w-48 truncate">{project?.title ?? "Choose repository"}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">
        {projects.map((candidate) => (
          <MenuItem key={projectKey(candidate)} onClick={() => onChange(candidate)}>
            <ProjectFavicon project={candidate} className="size-4" />
            <span className="min-w-0 truncate">{candidate.title}</span>
          </MenuItem>
        ))}
        {projects.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={() => {
            closeWorkspaceDialog("newWorkspace");
            openCommandPalette({ open: "add-project" });
          }}
        >
          <FolderPlusIcon />
          Add repository…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ProjectComposer({
  project,
  projects,
  onProjectChange,
  onCreated,
}: {
  project: Project;
  projects: ReadonlyArray<Project>;
  onProjectChange: (project: Project) => void;
  onCreated: () => void;
}) {
  const { environmentId } = project;
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
  const createWorkspace = useCreateWorkspace();

  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [checkout, setCheckout] = useState<CheckoutChoice | null>(null);
  const [issue, setIssue] = useState<WorkspaceIssue | null>(null);
  // The markdown appended for the attached issue, so detaching removes exactly it.
  const [issueBlock, setIssueBlock] = useState<string | null>(null);
  const [loadingIssue, setLoadingIssue] = useState(false);
  const latestIssueRequest = useRef(0);
  const promptRef = useRef<HTMLDivElement>(null);
  const readIssue = useReadIssue();

  const changeIssue = async (next: WorkspaceIssue | null) => {
    const request = ++latestIssueRequest.current;
    const withoutBlock = (text: string) =>
      issueBlock === null ? text : text.replace(issueBlock, "").trimEnd();
    setIssue(next);
    if (next === null) {
      setPrompt(withoutBlock);
      setIssueBlock(null);
      return;
    }
    setLoadingIssue(true);
    // The list carries no body; read the whole issue only once it's picked.
    const full = await readIssue(environmentId, project.id, next.number);
    if (request !== latestIssueRequest.current) return;
    setLoadingIssue(false);
    if (full === null) {
      setIssue(null);
      return;
    }
    const block = formatIssueForPrompt(full);
    setPrompt((current) => {
      const base = withoutBlock(current);
      return base.length > 0 ? `${base}\n\n${block}` : block;
    });
    setIssueBlock(block);
  };
  // Once the block is in, the caret goes after its trailing blank line, never inside the issue.
  useEffect(() => {
    if (issueBlock === null) return;
    const textarea = promptRef.current?.querySelector("textarea");
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [issueBlock]);

  // Shares the target picker's first page, so finding the default costs no extra request.
  const branches = usePaginatedBranches({ environmentId, cwd: project.workspaceRoot, query: "" });
  const defaultBranch =
    branches.refs.find((ref) => ref.isDefault && ref.isRemote !== true)?.name ??
    branches.refs.find((ref) => ref.isDefault)?.name ??
    "";
  const [pickedBaseRef, setPickedBaseRef] = useState<string | null>(null);
  const baseRef = pickedBaseRef ?? defaultBranch;
  const [startFromOrigin, setStartFromOrigin] = useState(
    projectSettings.newWorktreesStartFromOrigin,
  );

  // The same model a new chat in this project would start with.
  const stickySelection = useComposerDraftStore((state) =>
    state.stickyActiveProvider === null
      ? null
      : (state.stickyModelSelectionByProvider[state.stickyActiveProvider] ?? null),
  );
  const defaultSelection = resolveDefaultProviderModelSelection(
    providers,
    projectSettings.defaultModelSelection ?? stickySelection ?? settings.defaultModelSelection,
  );
  const [pickedSelection, setPickedSelection] = useState<ModelSelection | null>(null);
  const selection =
    pickedSelection ??
    (defaultSelection
      ? resolveEffectiveDefaultModelSelection(settings, providers, defaultSelection)
      : null);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, project.id),
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  const supportedModes = activeEntry?.snapshot.supportedRuntimeModes;
  const modes =
    supportedModes && supportedModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedModes.includes(mode))
      : runtimeModeOptions;
  const [pickedMode, setPickedMode] = useState<RuntimeMode | null>(null);
  const requestedMode = pickedMode ?? projectSettings.defaultRuntimeMode;
  const runtimeMode = modes.includes(requestedMode) ? requestedMode : (modes[0] ?? requestedMode);
  const ModeIcon = runtimeModeConfig[runtimeMode].icon;

  const submit = async () => {
    if (creating || loadingIssue) return;
    const baseIsRemote = branches.refs.find((ref) => ref.name === baseRef)?.isRemote === true;
    const localBase = baseIsRemote ? deriveLocalBranchNameFromRemoteRef(baseRef) : baseRef;
    const checkoutInput: Extract<WorkspaceCommand, { type: "create" }>["checkout"] =
      checkout === null
        ? { type: "new", startFromOrigin: startFromOrigin || baseIsRemote }
        : checkout.type === "branch"
          ? { type: "branch", branch: checkout.branch }
          : { type: "pullRequest", number: checkout.number };
    setCreating(true);
    const workspace = await createWorkspace(environmentId, project.id, {
      ...(localBase.length > 0 ? { baseRef: localBase } : {}),
      checkout: checkoutInput,
      prompt,
      ...(selection ? { modelSelection: selection } : {}),
      runtimeMode,
    });
    setCreating(false);
    if (workspace !== null) onCreated();
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1 border-b px-2 py-1.5">
        <ProjectMenu projects={projects} project={project} onChange={onProjectChange} />
        <TargetBranchPicker
          environmentId={environmentId}
          cwd={project.workspaceRoot}
          value={baseRef}
          onValueChange={setPickedBaseRef}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={setStartFromOrigin}
          disabled={creating}
        />
        <div className="ml-auto min-w-0">
          <CheckoutPicker
            environmentId={environmentId}
            projectId={project.id}
            cwd={project.workspaceRoot}
            value={checkout}
            onValueChange={(next) => {
              setCheckout(next);
              // A pull request is reviewed against its own base.
              if (next?.type === "pullRequest") setPickedBaseRef(next.baseBranch);
            }}
            issue={issue}
            onIssueChange={(next) => void changeIssue(next)}
          />
        </div>
      </div>
      <div ref={promptRef} className="px-1 pt-2">
        <Textarea
          unstyled
          autoFocus
          aria-label="What do you want to work on?"
          placeholder="What do you want to work on?"
          value={prompt}
          disabled={creating}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
        {selection && activeEntry ? (
          <>
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              isComposerOwned={false}
              onInstanceModelChange={(instanceId, model) =>
                setPickedSelection(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              isComposerOwned={false}
              onModelOptionsChange={(options) =>
                setPickedSelection(
                  createModelSelection(selection.instanceId, selection.model, options),
                )
              }
            />
          </>
        ) : null}
        <Select
          value={runtimeMode}
          onValueChange={(value) => {
            if (value !== null) setPickedMode(value);
          }}
        >
          <SelectTrigger size="compact" variant="ghost" aria-label="Access">
            <ModeIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <SelectValue>{runtimeModeConfig[runtimeMode].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {modes.map((mode) => {
              const option = runtimeModeConfig[mode];
              const Icon = option.icon;
              return (
                <SelectItem key={mode} value={mode} className="min-w-64">
                  <div className="grid gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <button
          type="button"
          aria-label={prompt.trim().length > 0 ? "Create workspace and send" : "Create workspace"}
          disabled={creating || loadingIssue}
          onClick={() => void submit()}
          className={cn(
            "relative isolate ml-auto flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
            "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
          )}
        >
          {creating ? (
            <Spinner size="sm" aria-hidden="true" />
          ) : (
            // The composer's own send arrow, so the two read as the same action.
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
