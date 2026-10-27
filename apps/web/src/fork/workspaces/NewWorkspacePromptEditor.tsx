import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInteractionMode,
  ServerProvider,
} from "@t3tools/contracts";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type RefObject } from "react";

import {
  type ComposerCommandItem,
  ComposerCommandMenu,
  composerSuggestionOptionId,
} from "../../components/chat/ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "../../components/chat/composerMenuHighlight";
import { searchSlashCommandItems } from "../../components/chat/composerSlashCommandSearch";
import { useComposerTriggerState } from "../../components/chat/useComposerTriggerState";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditor,
} from "../../components/ComposerPromptEditor";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
} from "../../components/composerContextPresentation";
import { buildPullRequestReferenceContext } from "../../components/pullRequest/pullRequestDetail.logic";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { usePullRequestList } from "../../state/pullRequests";
import { forkIssueReference, useForkHashMenu } from "./hashMentions";
import {
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isPathSuggestionCurrent,
  replaceTextRange,
} from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { basenameOfPath } from "../../pierre-icons";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useComposerPathSearch } from "../../state/queries";
import { primaryServerKeybindingsAtom } from "../../state/server";

const NO_SKILLS: ReadonlyArray<never> = [];

const noop = () => {};

/**
 * A slim copy of ChatComposer's trigger glue, for before a thread exists. A `#` pull request's
 * record lives in `reviewComments` and moves to the new draft. Files are searched in the
 * project's root checkout, since the worktree does not exist yet; mentions are relative, so
 * they resolve in the worktree too.
 */
export function NewWorkspacePromptEditor({
  editorRef,
  environmentId,
  projectId,
  cwd,
  provider,
  providerKind,
  richTextEnabled,
  showSkillsInSlashMenu,
  sendShortcut,
  value,
  reviewComments,
  onReviewCommentAdd,
  planModeEnabled,
  interactionMode,
  onInteractionModeChange,
  disabled,
  onChange,
  onSubmit,
}: {
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  provider: ServerProvider | null;
  providerKind: ProviderDriverKind | null;
  richTextEnabled: boolean;
  showSkillsInSlashMenu: boolean;
  sendShortcut?: Parameters<typeof composerSubmissionIntentForKey>[0]["sendShortcut"] | undefined;
  value: string;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  onReviewCommentAdd: (comment: ReviewCommentContext) => void;
  /** Offer /plan, /default, and Shift+Tab, which set the new chat's mode. */
  planModeEnabled: boolean;
  interactionMode: ProviderInteractionMode;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const listId = `${useId()}-suggestions`;
  const [cursor, setCursor] = useState(() => collapseExpandedComposerCursor(value, value.length));
  const { trigger, setTrigger, resolveTrigger, dismissTrigger } = useComposerTriggerState(
    () => null,
  );
  const [highlighted, setHighlighted] = useState<{
    readonly itemId: string | null;
    readonly searchKey: string | null;
  }>({ itemId: null, searchKey: null });

  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : NO_SKILLS;
  const slashCommands = provider ? resolveProviderSlashCommandsForCwd(provider, cwd) : NO_SKILLS;
  const isPathTrigger = trigger?.kind === "path";
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? cwd : null,
    query: isPathTrigger ? trigger.query : null,
  });

  const hashMenu = useForkHashMenu({ environmentId, projectId, trigger });
  // Without gh, `#` lists pull requests through upstream's source control, as the chat does.
  const hashQuery = trigger?.kind === "pull-request" ? trigger.query.trim() : "";
  const upstreamPullRequests = usePullRequestList(
    trigger?.kind === "pull-request" && hashMenu.items === null
      ? [
          {
            environmentId,
            input: {
              state: "open",
              projectId,
              limit: 20,
              ...(hashQuery.length > 0 ? { query: hashQuery } : {}),
            },
          },
        ]
      : [],
  );

  const items = ((): ComposerCommandItem[] => {
    if (!trigger) return [];
    if (trigger.kind === "pull-request") {
      if (hashMenu.items !== null) return [...hashMenu.items];
      return (upstreamPullRequests.data?.entries ?? []).map((entry) => ({
        id: `pull-request:${entry.projectId}:${entry.repository}:${entry.number}`,
        type: "pull-request" as const,
        pullRequest: {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          state: entry.state,
          isDraft: entry.isDraft,
        },
        label: `#${entry.number}`,
        description: entry.title,
      }));
    }
    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        searchTarget: pathSearch.searchedTarget,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (providerKind === null) return [];
    if (trigger.kind === "slash-command") {
      // The chat's /plan and /default set the new chat's mode; /model is left
      // out, since the footer's model picker covers it.
      const modeItems = planModeEnabled
        ? ([
            {
              id: "slash:plan",
              type: "slash-command",
              command: "plan",
              label: "/plan",
              description: "Switch this thread into plan mode",
            },
            {
              id: "slash:default",
              type: "slash-command",
              command: "default",
              label: "/default",
              description: "Switch this thread back to normal build mode",
            },
          ] as const)
        : [];
      const slashMenuSkills = getProviderSkillsForSlashMenu(skills, showSkillsInSlashMenu);
      const commandItems = getProviderSlashCommandsForSlashMenu(slashCommands, slashMenuSkills).map(
        (command) => ({
          id: `provider-slash-command:${providerKind}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: providerKind,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${providerKind}:${skill.name}`,
        type: "skill" as const,
        provider: providerKind,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      return searchSlashCommandItems(
        [...modeItems, ...commandItems, ...skillItems],
        trigger.query.trim().toLowerCase(),
      );
    }
    if (trigger.kind === "skill") {
      return searchProviderSkills(skills, trigger.query).map((skill) => ({
        id: `skill:${providerKind}:${skill.name}`,
        type: "skill" as const,
        provider: providerKind,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    return [];
  })();

  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const activeItemId = resolveComposerMenuActiveItemId({
    items,
    highlightedItemId: highlighted.itemId,
    currentSearchKey: searchKey,
    highlightedSearchKey: highlighted.searchKey,
  });
  const activeItem = items.find((item) => item.id === activeItemId) ?? null;
  // An empty `@` query is never searched; counting its debounce as loading
  // would open the menu for a moment and shut it again.
  const isLoading =
    (isPathTrigger && trigger.query.length > 0 && pathSearch.isPending) ||
    (trigger?.kind === "pull-request" &&
      (hashMenu.items !== null
        ? hashMenu.isLoading
        : upstreamPullRequests.isPending && upstreamPullRequests.data === null));
  // Open for any trigger, empty or not, as in the chat composer.
  const menuVisible = trigger !== null;
  const emptyStateText =
    trigger?.kind === "path"
      ? trigger.query.length === 0
        ? "Type to search files in this repository."
        : "No matching files or folders."
      : trigger?.kind === "skill"
        ? "No skills found. Try / to browse provider commands."
        : trigger?.kind === "pull-request"
          ? "No open pull request or issue matches."
          : "No matching command.";

  const replace = (rangeStart: number, rangeEnd: number, replacement: string) => {
    const current = editorRef.current?.readSnapshot().value ?? value;
    // A replacement ending in a space swallows one that already follows.
    const end = replacement.endsWith(" ") && current[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const next = replaceTextRange(current, rangeStart, end, replacement);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    onChange(next.text);
    setCursor(nextCursor);
    setTrigger(
      detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
    );
    setHighlighted({ itemId: null, searchKey: null });
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  const currentTrigger = () => {
    const snapshot = editorRef.current?.readSnapshot();
    return snapshot
      ? resolveTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor))
      : trigger;
  };

  const select = (item: ComposerCommandItem) => {
    const active = currentTrigger();
    if (!active) return;
    if (item.type === "path") {
      if (!isPathSuggestionCurrent(item.searchTarget, active, environmentId, cwd)) return;
      replace(active.rangeStart, active.rangeEnd, `${serializeComposerFileLink(item.path)} `);
    } else if (item.type === "issue") {
      const { comment, replacement } = forkIssueReference(item);
      replace(active.rangeStart, active.rangeEnd, replacement);
      onReviewCommentAdd(comment);
    } else if (item.type === "pull-request") {
      const comment = buildPullRequestReferenceContext(item.pullRequest);
      replace(
        active.rangeStart,
        active.rangeEnd,
        `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
      );
      onReviewCommentAdd(comment);
    } else if (item.type === "skill") {
      replace(active.rangeStart, active.rangeEnd, `$${item.skill.name} `);
    } else if (item.type === "slash-command") {
      replace(active.rangeStart, active.rangeEnd, "");
      onInteractionModeChange(item.command === "plan" ? "plan" : "default");
    } else if (item.type === "provider-slash-command") {
      replace(active.rangeStart, active.rangeEnd, `/${item.command.name} `);
    }
  };

  const nudge = (direction: 1 | -1) => {
    if (items.length === 0) return;
    const index = items.findIndex((item) => item.id === activeItemId);
    const from = index >= 0 ? index : direction === 1 ? -1 : 0;
    const next = items[(from + direction + items.length) % items.length];
    setHighlighted({ itemId: next?.id ?? null, searchKey });
  };

  const onCommandKeyDown = (key: string, event: KeyboardEvent) => {
    if (key === "Tab" && event.shiftKey && planModeEnabled) {
      onInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
      return true;
    }
    const active = currentTrigger();
    if (key === "Escape" && active !== null) {
      if (event.isComposing) return false;
      dismissTrigger(active);
      return true;
    }
    if (active !== null && items.length > 0) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        nudge(key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        const item = activeItem ?? items[0];
        if (item) select(item);
        return true;
      }
    }
    // The user's send shortcut, as in the chat composer.
    const intent = composerSubmissionIntentForKey({
      event,
      keybindings,
      isSoftwareKeyboardOpen: false,
      isDraftThread: true,
      ...(sendShortcut === undefined ? {} : { sendShortcut }),
      prompt: editorRef.current?.readSnapshot().value ?? value,
    });
    if (intent !== null) {
      onSubmit();
      return true;
    }
    return false;
  };

  return (
    <ComposerContextActionsContext
      value={{
        environmentId,
        cwd,
        expandImage: noop,
        expandVideo: noop,
        openFile: noop,
        openMention: noop,
        openPullRequest: noop,
      }}
    >
      <ComposerPromptEditor
        ariaLabel="What do you want to work on?"
        placeholder="What do you want to work on?"
        editorRef={editorRef}
        richTextEnabled={richTextEnabled}
        suggestionListId={listId}
        activeSuggestionId={
          menuVisible && activeItem ? composerSuggestionOptionId(listId, activeItem.id) : undefined
        }
        isPathQueryActive={() => currentTrigger()?.kind === "path"}
        value={value}
        cursor={cursor}
        contextRecords={composerContextRecordsFromDraft({ terminalContexts: [], reviewComments })}
        skills={skills}
        disabled={disabled}
        className="max-h-64 min-h-20"
        onChange={(nextValue, nextCursor, expandedCursor, suppressTrigger) => {
          onChange(nextValue);
          setCursor(nextCursor);
          setTrigger(suppressTrigger ? null : detectComposerTrigger(nextValue, expandedCursor));
        }}
        onPaste={noop}
        onCommandKeyDown={onCommandKeyDown}
      />
      {menuVisible ? (
        // Floats over the dialog below the editor, like a popover, instead of
        // growing the dialog. The dialog popup does not clip its children.
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-xl border bg-popover shadow-lg">
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={isLoading}
            triggerKind={trigger.kind}
            emptyStateText={
              isLoading && isPathTrigger ? "Searching repository files..." : emptyStateText
            }
            activeItemId={activeItem?.id ?? null}
            onHighlightedItemChange={(itemId) => setHighlighted({ itemId, searchKey })}
            onSelect={select}
          />
        </div>
      ) : null}
    </ComposerContextActionsContext>
  );
}
