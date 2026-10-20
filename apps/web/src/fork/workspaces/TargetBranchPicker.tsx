import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { BranchPicker, BranchPickerRefItem } from "../../components/BranchPicker";
import { sanitizeNewRefName } from "../../components/BranchToolbar.logic";
import { Button } from "../../components/ui/button";
import { ComboboxTrigger } from "../../components/ui/combobox";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { usePaginatedBranches } from "../../state/queries";

/**
 * Upstream's WorktreeBaseBranchPicker with a ghost trigger showing only the
 * branch name, so it reads like the other controls in the new-workspace
 * header. Keep the rest in step with `components/WorktreeBaseBranchPicker.tsx`.
 */
export function TargetBranchPicker({
  environmentId,
  cwd,
  value,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  disabled = false,
  id,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  value: string;
  onValueChange: (branch: string) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const branches = usePaginatedBranches({
    environmentId,
    cwd,
    query: sanitizeNewRefName(deferredQuery),
  });
  // Just the ref's name: the switch inside already says whether origin is used.
  const label = value || "Select branch";
  const branchByName = new Map(branches.refs.map((branch) => [branch.name, branch]));
  const items = [...branchByName.keys()];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    branches.error ??
    (branches.isPending && branches.data === null
      ? "Loading refs..."
      : branches.isFetchingNextPage
        ? "Loading more refs..."
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || null}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      onSelectItem={(name) => {
        onValueChange(name);
        handleOpenChange(false);
      }}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      originControl={{ checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }}
      popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
      renderItem={(name, index) => {
        const branch = branchByName.get(name);
        return branch ? (
          <BranchPickerRefItem
            branch={branch}
            projectCwd={cwd}
            index={index}
            onClick={() => {
              onValueChange(branch.name);
              handleOpenChange(false);
            }}
          />
        ) : null;
      }}
    >
      <ComboboxTrigger
        id={id}
        disabled={disabled || !cwd}
        render={<Button variant="ghost" size="xs" />}
        aria-label="Target branch"
      >
        <GitBranchIcon className="text-muted-foreground" />
        <MiddleTruncate value={label} className="max-w-48" />
        <ChevronDownIcon className="text-muted-foreground" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
