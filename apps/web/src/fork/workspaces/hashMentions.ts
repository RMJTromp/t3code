import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ComposerCommandItem } from "../../components/chat/ComposerCommandMenu";
import type { ComposerTrigger } from "../../composer-logic";
import { useDebouncedValue } from "../../state/queries";
import { useGhList } from "./github";
import type { ForkIssueCommandItem } from "./hashMentionItems";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import { buildIssueReferenceContext } from "./issueContext";
import { matchHashReferences } from "./logic";

const HASH_RESULT_LIMIT = 20;

/**
 * `#` suggestions from the GitHub CLI: open pull requests and issues together.
 * Numbers filter the cached lists at once; text also searches through gh.
 * `items` is null when gh is unavailable, so callers keep their own lookup.
 */
export function useForkHashMenu(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly trigger: ComposerTrigger | null;
}) {
  const active = input.trigger?.kind === "pull-request" && input.projectId !== null;
  const query = active ? (input.trigger?.query.trim() ?? "") : "";
  const textQuery = /^\d*$/.test(query) ? "" : query;
  const remoteQuery = useDebouncedValue(textQuery, 250);
  const target = {
    environmentId: input.environmentId,
    projectId: input.projectId,
    query: remoteQuery,
    enabled: active,
  };
  const pullRequests = useGhList({ ...target, kind: "pullRequests" });
  const issues = useGhList({ ...target, kind: "issues" });

  if (!active || pullRequests.error !== null) {
    return { items: null, isLoading: false };
  }
  const candidates = [
    ...pullRequests.items.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      item: {
        id: `pull-request:gh:${pullRequest.url}`,
        type: "pull-request" as const,
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: "open" as const,
          isDraft: pullRequest.isDraft,
        },
        label: `#${pullRequest.number}`,
        description: pullRequest.title,
      } satisfies ComposerCommandItem,
    })),
    ...issues.items.map((issue) => ({
      number: issue.number,
      title: issue.title,
      item: {
        id: `issue:${issue.url}`,
        type: "issue" as const,
        issue: { number: issue.number, title: issue.title, url: issue.url },
        label: `#${issue.number}`,
        description: issue.title,
      } satisfies ForkIssueCommandItem,
    })),
  ];
  // gh's search also matches bodies, so its text results are kept as they are.
  const items = matchHashReferences(
    candidates,
    textQuery.length > 0 && textQuery === remoteQuery ? "" : query,
    HASH_RESULT_LIMIT,
  ).map((candidate) => candidate.item);
  return {
    items,
    isLoading: items.length === 0 && (pullRequests.isPending || issues.isPending),
  };
}

/**
 * An issue suggestion becomes a context chip, like a pull request: the record
 * to add to the draft, and the inline reference (plus the space ending it).
 */
export function forkIssueReference(item: ForkIssueCommandItem) {
  const comment = buildIssueReferenceContext(item.issue);
  return {
    comment,
    replacement: `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
  };
}
