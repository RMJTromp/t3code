import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { formatGeneratedBranchName } from "@t3tools/shared/git";

import type { BranchNameGenerationInput, BranchNameGenerationResult } from "../textGeneration.ts";
import type { Runner } from "../textGenerationOperations.ts";

const outputSchema = Schema.Struct({
  status: Schema.Literals(["named", "inconclusive"]),
  branch: Schema.String,
});

const staticPrefix = (naming: BranchNameGenerationInput["naming"]) =>
  naming?.mode === "static" ? naming.prefix.trim().replace(/\/+$/, "") : "";

function namingModeRules(naming: BranchNameGenerationInput["naming"]): ReadonlyArray<string> {
  if (naming?.mode === "custom") {
    return [
      "Follow the user's naming instructions at the end of this prompt. Return the complete branch name; nothing is added to it.",
    ];
  }
  if (naming?.mode === "semantic") {
    return [
      "Start the name with a type and a slash: feat/, fix/, refactor/, perf/, docs/, test/, or chore/. For example fix/logout-redirect or feat/reports-csv-export.",
    ];
  }
  const prefix = staticPrefix(naming);
  return [
    "Lead with fix- for a bug and add- for a new feature when it reads naturally.",
    ...(prefix.length > 0
      ? [
          `The full branch name starts with the prefix \`${prefix}/\`, for example \`${prefix}/fix-logout-redirect\`. Return it with that prefix.`,
        ]
      : []),
  ];
}

/** `input.message` holds the workspace conversation so far, oldest first. */
function buildForkBranchNamePrompt(input: BranchNameGenerationInput) {
  const instructions = input.naming?.mode === "custom" ? input.naming.instructions.trim() : "";
  const prompt = [
    "You name the git branch of a coding workspace from the conversation so far between the user and a coding agent working there.",
    "The branch is named once, as soon as the conversation shows the task the workspace exists for. Users often start with setup chores; those must not name the branch.",
    'Return a JSON object with keys status ("named" or "inconclusive") and branch.',
    "",
    "Decide first:",
    '- status "inconclusive" and branch "": so far the user has only asked for housekeeping, so the task is still unknown. Housekeeping includes merging, rebasing, or pulling another branch; resolving merge conflicts; installing dependencies; building, running, linting, or testing the project; database migrations or seeds; starting a dev server; checking git status or logs; greetings; questions about the agent or its tools; and requests too vague to name, such as "hi", "continue", or "fix this" with nothing else.',
    '- status "named": the user asked for a change, a fix, an investigation, or an answer about the product or codebase. When housekeeping and a real task appear together, name the real task.',
    "",
    "Use the agent's replies to understand what the user referred to. When the user points at an issue, pull request, link, or file, name what the agent found it to be about.",
    "",
    "Examples, with names shown without any prefix:",
    '- User: "merge master into this branch" -> inconclusive',
    '- User: "run npm install and npm run build" -> inconclusive',
    '- User: "php artisan migrate --seed" -> inconclusive',
    '- User: "pull latest main and fix the conflicts" -> inconclusive',
    '- User: "what model are you?" -> inconclusive',
    '- User: "after logout the app sends me to /home, it should go to /login" -> named: fix-logout-redirect',
    '- User: "merge master first, then add CSV export to the reports page" -> named: add-reports-csv-export',
    '- User: "investigate issue #3928". Agent: "Issue #3928 reports that the sidebar flickers while resizing..." -> named: fix-sidebar-resize-flicker',
    '- User: "why is the invoices query so slow?" -> named: invoices-query-performance',
    "",
    "Naming rules:",
    "- Name the subject and the outcome: which part of the product changes, and how. Prefer concrete nouns from the conversation (a page, component, feature, or endpoint) and specific problem words (redirect, flicker, timeout, export, crash).",
    "- 2-5 words, lowercase, hyphen-separated, ASCII letters and digits only.",
    "- Never name the branch after a reference itself, such as issue-3928, pr-12, or investigate-issue.",
    "- Avoid words that describe how the agent works instead of what changes: investigate, look-into, check, review, task, work, update, changes, stuff, misc, wip, temp, new, branch, issue, ticket, pr.",
    "- Avoid words from setup chores: merge, master, main, rebase, conflicts, build, install, migrate, npm, pnpm, composer, artisan.",
    "- Avoid generic words when a specific one exists: bug, problem, error, improve.",
    ...namingModeRules(input.naming).map((rule) => `- ${rule}`),
    "",
    "Conversation:",
    input.message,
    ...(instructions.length > 0 ? ["", "User's naming instructions:", instructions] : []),
  ].join("\n");
  return { prompt, outputSchema };
}

export function toForkBranchNameResult(
  generated: typeof outputSchema.Type,
  naming: BranchNameGenerationInput["naming"],
): BranchNameGenerationResult {
  const raw = generated.branch.trim();
  if (generated.status === "inconclusive" || raw.length === 0) {
    return { branch: "", inconclusive: true };
  }
  // The model is asked to include a static prefix; strip it so formatting adds it exactly once.
  const prefix = staticPrefix(naming);
  const fragment =
    prefix.length > 0 && raw.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
      ? raw.slice(prefix.length + 1)
      : raw;
  return { branch: formatGeneratedBranchName(fragment, naming) };
}

export const forkGenerateBranchName = Effect.fn("ForkBranchNaming.generate")(function* (
  run: Runner,
  input: BranchNameGenerationInput,
) {
  const generated = yield* run({
    operation: "generateBranchName",
    cwd: input.cwd,
    modelSelection: input.modelSelection,
    ...buildForkBranchNamePrompt(input),
  });
  return toForkBranchNameResult(generated, input.naming);
});
