import type {
  EnvironmentId,
  ProjectId,
  PullRequestState,
  VcsRef,
  WorkspaceIssue,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef } from "@t3tools/shared/git";
import { LegendList } from "@legendapp/list/react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { CircleDotIcon, GitBranchIcon, GitBranchPlusIcon, XIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useDeferredValue, useRef, useState } from "react";

import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../../components/pullRequest/pullRequestPresentation";
import { cn } from "../../lib/utils";
import { ForkIssueIcon } from "./hashMentionItems";
import { sanitizeNewRefName } from "../../components/BranchToolbar.logic";
import { Button } from "../../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
} from "../../components/ui/combobox";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { usePullRequestList } from "../../state/pullRequests";
import { usePaginatedBranches } from "../../state/queries";
import { useGhList } from "./github";

/** An existing branch or pull request the workspace checks out instead of a new branch. */
export type CheckoutChoice =
  | { readonly type: "branch"; readonly branch: string }
  | {
      readonly type: "pullRequest";
      readonly number: number;
      readonly title: string;
      readonly baseBranch: string;
    };

type Tab = "branches" | "pullRequests" | "issues";

/**
 * Branches, pull requests, and issues share one popup, with tabs, as in
 * Conductor. A branch or pull request is what the workspace checks out; an
 * issue is attached to the first message instead. Lists load only while open.
 */
export function CheckoutPicker({
  environmentId,
  projectId,
  cwd,
  value,
  onValueChange,
  issue,
  onIssueChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  value: CheckoutChoice | null;
  onValueChange: (value: CheckoutChoice | null) => void;
  issue: WorkspaceIssue | null;
  onIssueChange: (issue: WorkspaceIssue | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("branches");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  // Pull requests and issues come from the host's API, so typing waits a beat.
  const [remoteQuery] = useDebouncedValue(query.trim(), { wait: 300 });

  // Everything loads as soon as the dialog opens, so no tab waits on a click.
  const branches = usePaginatedBranches({
    environmentId,
    cwd,
    query: sanitizeNewRefName(deferredQuery),
  });
  const ghPullRequests = useGhList({
    environmentId,
    projectId,
    kind: "pullRequests",
    query: remoteQuery,
    enabled: true,
  });
  // Without a working gh, upstream's source-control integration lists them instead.
  const fallBackToUpstream = ghPullRequests.error !== null;
  const upstreamPullRequests = usePullRequestList(
    fallBackToUpstream
      ? [
          {
            environmentId,
            input: {
              state: "open",
              projectId,
              limit: 50,
              ...(remoteQuery.length > 0 ? { query: remoteQuery } : {}),
            },
          },
        ]
      : [],
  );
  const pullRequests = fallBackToUpstream
    ? {
        items: upstreamPullRequests.data?.entries ?? [],
        error: upstreamPullRequests.error,
        isPending: upstreamPullRequests.isPending && upstreamPullRequests.data === null,
      }
    : ghPullRequests;
  const issues = useGhList({
    environmentId,
    projectId,
    kind: "issues",
    query: remoteQuery,
    enabled: true,
  });

  const localNames = new Set(branches.refs.filter((ref) => !ref.isRemote).map((ref) => ref.name));
  const branchByName = new Map<string, VcsRef>();
  for (const ref of branches.refs) {
    // Remote refs check out under their local name; skip the duplicate.
    if (ref.isRemote && localNames.has(deriveLocalBranchNameFromRemoteRef(ref.name))) continue;
    branchByName.set(ref.name, ref);
  }
  const pullRequestByKey = new Map<
    string,
    {
      number: number;
      title: string;
      headBranch: string;
      baseBranch: string;
      state?: PullRequestState;
      isDraft: boolean;
    }
  >(pullRequests.items.map((entry) => [`#${entry.number}`, entry]));
  const issueByKey = new Map(issues.items.map((issue) => [`#${issue.number}`, issue]));
  const items =
    tab === "branches"
      ? [...branchByName.keys()]
      : tab === "pullRequests"
        ? [...pullRequestByKey.keys()]
        : [...issueByKey.keys()];
  const statusText =
    tab === "branches"
      ? (branches.error ??
        (branches.isPending && branches.data === null ? "Loading branches..." : null))
      : tab === "pullRequests"
        ? (pullRequests.error ??
          (pullRequests.isPending && items.length === 0 ? "Loading pull requests..." : null))
        : (issues.error ?? (issues.isPending && items.length === 0 ? "Loading issues..." : null));

  const select = (key: string) => {
    const ref = branchByName.get(key);
    const pullRequest = pullRequestByKey.get(key);
    const picked = issueByKey.get(key);
    if (tab === "issues" && picked) {
      onIssueChange(picked);
    } else if (tab === "branches" && ref) {
      onValueChange({
        type: "branch",
        branch: ref.isRemote ? deriveLocalBranchNameFromRemoteRef(ref.name) : ref.name,
      });
    } else if (tab === "pullRequests" && pullRequest) {
      onValueChange({
        type: "pullRequest",
        number: pullRequest.number,
        title: pullRequest.title,
        baseBranch: pullRequest.baseBranch,
      });
    }
    handleOpenChange(false);
  };
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const openOn = (next: Tab) => {
    setTab(next);
    handleOpenChange(true);
  };

  return (
    <div ref={anchorRef} className="flex min-w-0 items-center gap-0.5">
      {value === null && issue === null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Check out a branch or pull request, or attach an issue"
          onClick={() => handleOpenChange(true)}
        >
          <GitBranchPlusIcon />
        </Button>
      ) : null}
      {value !== null ? (
        <SelectionChip
          icon={value.type === "pullRequest" ? PullRequestGlyph.pullRequest : GitBranchIcon}
          label={value.type === "branch" ? value.branch : `#${value.number} ${value.title}`}
          openLabel="Change what this workspace checks out"
          clearLabel="Create a new branch instead"
          onOpen={() => openOn(value.type === "branch" ? "branches" : "pullRequests")}
          onClear={() => onValueChange(null)}
        />
      ) : null}
      {issue !== null ? (
        <SelectionChip
          icon={CircleDotIcon}
          label={`#${issue.number} ${issue.title}`}
          openLabel="Change the attached issue"
          clearLabel={`Detach issue #${issue.number}`}
          onOpen={() => openOn("issues")}
          onClear={() => onIssueChange(null)}
        />
      ) : null}
      {/* Anchored to the row, since the selections replace a single trigger. */}
      <Combobox
        items={items}
        filteredItems={items}
        autoHighlight
        virtualized
        open={open}
        onOpenChange={handleOpenChange}
        value={null}
      >
        <ComboboxPopup align="end" anchor={anchorRef} className="flex w-96 flex-col">
          <ComboboxSearchInput
            placeholder={
              tab === "branches"
                ? "Search branches..."
                : tab === "pullRequests"
                  ? "Search pull requests..."
                  : "Search issues..."
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex px-3 pt-2 *:flex-1 **:data-[slot=toggle]:flex-1">
            <ToggleGroup
              aria-label="What to check out"
              value={[tab]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "branches" || next === "pullRequests" || next === "issues") {
                  setTab(next);
                }
              }}
            >
              <Toggle value="branches">Branches</Toggle>
              <Toggle value="pullRequests">Pull requests</Toggle>
              <Toggle value="issues">Issues</Toggle>
            </ToggleGroup>
          </div>
          <ComboboxEmpty>
            {tab === "branches"
              ? "No branches found."
              : tab === "pullRequests"
                ? "No open pull requests."
                : "No open issues."}
          </ComboboxEmpty>
          <div className="relative flex max-h-72 min-h-0 w-full flex-1 flex-col overflow-hidden">
            <ComboboxListVirtualized className="flex size-full min-h-0 min-w-0 flex-col">
              <LegendList<string>
                data={items}
                keyExtractor={(item) => `${tab}:${item}`}
                estimatedItemSize={28}
                drawDistance={336}
                onEndReached={() => {
                  if (
                    tab === "branches" &&
                    branches.data?.nextCursor != null &&
                    !branches.isFetchingNextPage
                  ) {
                    branches.loadNext();
                  }
                }}
                renderItem={({ item, index }) => {
                  const ref = tab === "branches" ? branchByName.get(item) : undefined;
                  if (ref) {
                    return (
                      <ComboboxItem
                        hideIndicator
                        index={index}
                        value={item}
                        // Git refuses a second checkout of a branch another folder holds.
                        disabled={ref.worktreePath !== null}
                        onClick={() => select(item)}
                      >
                        <PickerRow
                          icon={<GitBranchIcon className="size-4 shrink-0 text-secondary-label" />}
                          label={ref.name}
                          badge={branchBadge(ref, cwd)}
                        />
                      </ComboboxItem>
                    );
                  }
                  const pullRequest = tab === "pullRequests" ? pullRequestByKey.get(item) : null;
                  const issue = tab === "issues" ? issueByKey.get(item) : null;
                  const title = pullRequest?.title ?? issue?.title;
                  if (title === undefined) return null;
                  const presentation = pullRequest
                    ? resolvePullRequestState({
                        state: pullRequest.state ?? "open",
                        isDraft: pullRequest.isDraft,
                      })
                    : null;
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={item}
                      onClick={() => select(item)}
                    >
                      <PickerRow
                        icon={
                          presentation ? (
                            <presentation.Icon
                              role="img"
                              aria-label={presentation.label}
                              className={cn("size-4 shrink-0", presentation.toneClassName)}
                            />
                          ) : (
                            <ForkIssueIcon />
                          )
                        }
                        label={item}
                        description={title}
                      />
                    </ComboboxItem>
                  );
                }}
                className="min-h-0 max-h-72 overflow-x-hidden overscroll-y-contain px-1 py-2"
              />
            </ComboboxListVirtualized>
          </div>
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

/** The `#` menu's row layout (ComposerCommandMenu), so both lists read the same. */
function PickerRow({
  icon,
  label,
  description,
  badge,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  badge?: string | null;
}) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {icon}
      <span
        className={cn(
          "min-w-0 shrink-0 truncate font-sans text-xs font-medium",
          description !== undefined && "max-w-[45%]",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
        {description}
      </span>
      {badge ? <span className="shrink-0 text-3xs text-muted-foreground/45">{badge}</span> : null}
    </span>
  );
}

/** The same badges as upstream's branch picker rows. */
function branchBadge(ref: VcsRef, projectCwd: string): string | null {
  if (ref.current) return "current";
  if (ref.worktreePath && ref.worktreePath !== projectCwd) return "worktree";
  if (ref.isRemote) return "remote";
  return ref.isDefault ? "default" : null;
}

/** A picked branch, pull request, or issue; its icon turns into a remove button on hover. */
function SelectionChip({
  icon: Icon,
  label,
  openLabel,
  clearLabel,
  onOpen,
  onClear,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  openLabel: string;
  clearLabel: string;
  onOpen: () => void;
  onClear: () => void;
}) {
  return (
    <div className="group/chip relative flex min-w-0 items-center">
      <Button variant="ghost" size="xs" aria-label={`${openLabel}: ${label}`} onClick={onOpen}>
        <Icon className="text-muted-foreground group-focus-within/chip:invisible group-hover/chip:invisible" />
        <MiddleTruncate value={label} className="max-w-48" />
      </Button>
      <Button
        size="icon-tiny"
        variant="ghost-muted"
        aria-label={clearLabel}
        className="absolute left-1.5 hidden group-focus-within/chip:flex group-hover/chip:flex"
        onClick={onClear}
      >
        <XIcon />
      </Button>
    </div>
  );
}
