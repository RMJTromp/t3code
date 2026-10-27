import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

const MESSAGE_MAX_CHARS = 2_000;
const CONVERSATION_MAX_CHARS = 16_000;

/**
 * The chat so far, oldest first. When it is too long, the oldest messages go: a task that came
 * first would already have named the branch, so what is left to name is recent.
 */
function formatNamingConversation(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>,
): string | null {
  const entries = messages.flatMap((message) => {
    const text = message.text.trim();
    if (message.streaming || text.length === 0) return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    const clipped =
      text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)} [...]` : text;
    return [`${message.role === "user" ? "User" : "Agent"}: ${clipped}`];
  });
  if (!entries.some((entry) => entry.startsWith("User: "))) return null;
  const kept: Array<string> = [];
  let length = 0;
  for (const entry of entries.toReversed()) {
    if (kept.length > 0 && length + entry.length > CONVERSATION_MAX_CHARS) break;
    kept.unshift(entry);
    length += entry.length + 2;
  }
  return kept.join("\n\n");
}

/**
 * Names a new workspace's placeholder branch from its chat once the chat shows the task. Returns
 * false when the model judged the chat so far to be setup chores, so a later turn tries again.
 */
export const nameWorkspaceBranch = Effect.fn("WorkspaceBranchNaming.name")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly branch: string;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const records = yield* threads.getThreadRecords(input.threadId, ["messages"], {
    messageRoles: ["user", "assistant"],
  });
  const conversation = formatNamingConversation(records.messages);
  if (conversation === null) return false;

  const settings = resolveProjectSettings(
    yield* serverSettings.getSettings,
    input.projectId,
  ).settings;
  const modelSelection =
    settings.sourceControlWriterModelSelection === null
      ? settings.textGenerationModelSelection
      : ServerSettings.resolveSourceControlWriterModelSelection(
          settings,
          yield* providerRegistry.getProviders,
          input.projectId,
        );
  const generated = yield* textGeneration.generateBranchName({
    naming: {
      mode: settings.branchNamingMode,
      prefix: settings.branchNamePrefix,
      instructions: settings.branchNameInstructions,
    },
    cwd: input.worktreePath,
    message: conversation,
    modelSelection,
    forkConversation: true,
  });
  if (generated.inconclusive) return false;

  const renamed = yield* git.renameBranch({
    cwd: input.worktreePath,
    oldBranch: input.branch,
    newBranch: generated.branch,
    ...(settings.branchNamingMode === "custom" ? { exactName: true } : {}),
  });
  // Every chat on the checkout moves with it, archived ones too, as upstream's rename does.
  const shells = yield* Effect.forEach(["active", "archive"] as const, (location) =>
    threads.getShellSnapshot({ location }).pipe(Effect.map((snapshot) => snapshot.threads)),
  );
  for (const thread of shells.flat()) {
    if (thread.worktreePath !== input.worktreePath || thread.branch !== input.branch) continue;
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`fork-branch-name:${thread.id}:${renamed.branch}`),
        threadId: thread.id,
        branch: renamed.branch,
        expectedBranch: input.branch,
        expectedWorktreePath: input.worktreePath,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace chat branch update failed", { threadId: thread.id, cause }),
        ),
      );
  }
  return true;
});
