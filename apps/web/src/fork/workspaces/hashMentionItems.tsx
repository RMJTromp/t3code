import { CircleDotIcon } from "lucide-react";

import { PULL_REQUEST_STATE_PRESENTATION } from "../../components/pullRequest/pullRequestIcons";
import { cn } from "../../lib/utils";

// Kept apart from hashMentions.ts so upstream's command menu imports no connection runtime.

/** A `#` suggestion for an issue; pull requests reuse upstream's item and chip. */
export interface ForkIssueCommandItem {
  readonly id: string;
  readonly type: "issue";
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly label: string;
  readonly description: string;
}

export function ForkIssueIcon() {
  // The open pull request's tone, so open issues and PRs read alike in the menu.
  return (
    <CircleDotIcon
      aria-hidden="true"
      className={cn("size-4 shrink-0", PULL_REQUEST_STATE_PRESENTATION.open.toneClassName)}
    />
  );
}
