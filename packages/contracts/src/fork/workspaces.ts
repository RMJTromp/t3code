/**
 * Fork-owned: Conductor-style workspaces. A workspace is a durable git worktree
 * that groups the project's threads whose `worktreePath` matches its path.
 * See docs/fork/README.md for the boundary rules this layer follows.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const WorkspaceId = TrimmedNonEmptyString.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspaceStatus = Schema.Literals([
  "creating",
  "ready",
  "archiving",
  "archived",
  "failed",
]);
export type WorkspaceStatus = typeof WorkspaceStatus.Type;

export const WorkspacePendingOperation = Schema.Literals(["create", "archive", "unarchive"]);
export type WorkspacePendingOperation = typeof WorkspacePendingOperation.Type;

export const WorkspaceScriptKind = Schema.Literals(["setup", "archive"]);
export type WorkspaceScriptKind = typeof WorkspaceScriptKind.Type;

export const WorkspaceScriptRun = Schema.Struct({
  kind: WorkspaceScriptKind,
  command: Schema.String,
  phase: Schema.Literals(["running", "succeeded", "failed"]),
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceScriptRun = typeof WorkspaceScriptRun.Type;

export const WorkspaceRunningScript = Schema.Struct({
  scriptId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
});
export type WorkspaceRunningScript = typeof WorkspaceRunningScript.Type;

/** A named project script a workspace can run on demand from the right panel. */
export const ProjectExtraScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  command: Schema.String,
});
export type ProjectExtraScript = typeof ProjectExtraScript.Type;

/** Workspace scripts set in Settings; an empty setup or archive falls back to t3.json. */
export const ProjectWorkspaceScripts = Schema.Struct({
  projectId: ProjectId,
  setup: Schema.String,
  archive: Schema.String,
  scripts: Schema.Array(ProjectExtraScript),
});
export type ProjectWorkspaceScripts = typeof ProjectWorkspaceScripts.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  /** Read from the worktree when archiving; the user may rename or switch it. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  status: WorkspaceStatus,
  pendingOperation: Schema.NullOr(WorkspacePendingOperation),
  error: Schema.NullOr(Schema.String),
  lastScript: Schema.NullOr(WorkspaceScriptRun),
  /** The terminal showing setup output, in the chat whose right panel opens it. */
  setupTerminal: Schema.NullOr(
    Schema.Struct({ threadId: ThreadId, terminalId: TrimmedNonEmptyString }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Extra project scripts running in this workspace's terminals. */
  runningScripts: Schema.Array(WorkspaceRunningScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Workspace = typeof Workspace.Type;

/** The first event carries the whole retained log, later ones only what was appended. */
export const WorkspaceLogEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("append"), text: Schema.String }),
]);
export type WorkspaceLogEvent = typeof WorkspaceLogEvent.Type;

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals([
    "not-found",
    "project-not-found",
    "invalid-state",
    "agents-running",
    "uncommitted-changes",
    "git-failed",
    "script-failed",
    "persistence-failed",
  ]),
  message: Schema.String,
  /** Uncommitted and untracked paths when `reason` is `uncommitted-changes`. */
  changedFiles: Schema.optional(Schema.Array(Schema.String)),
}) {}

export const WorkspaceCreateInput = Schema.Struct({
  projectId: ProjectId,
  /** The client's draft for this workspace; setup output streams into its terminal. */
  setupThreadId: Schema.optional(ThreadId),
});
export type WorkspaceCreateInput = typeof WorkspaceCreateInput.Type;

export const WorkspaceRefInput = Schema.Struct({ workspaceId: WorkspaceId });
export type WorkspaceRefInput = typeof WorkspaceRefInput.Type;

export const WorkspaceArchiveInput = Schema.Struct({
  workspaceId: WorkspaceId,
  /** Separate from `ignoreScriptFailure` so getting past a failed script never discards files. */
  discardChanges: Schema.optional(Schema.Boolean),
  ignoreScriptFailure: Schema.optional(Schema.Boolean),
});
export type WorkspaceArchiveInput = typeof WorkspaceArchiveInput.Type;

export const WorkspaceRunScriptInput = Schema.Struct({
  workspaceId: WorkspaceId,
  scriptId: TrimmedNonEmptyString,
  /** The chat in view; the script runs in a terminal in its right panel. */
  threadId: ThreadId,
});
export type WorkspaceRunScriptInput = typeof WorkspaceRunScriptInput.Type;

/**
 * Every fork mutation travels through one RPC. Upstream's RPC group sits close
 * to a TypeScript complexity limit, so each extra fork RPC risks breaking the
 * build on the next upstream merge.
 */
export const WorkspaceCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create"), ...WorkspaceCreateInput.fields }),
  Schema.Struct({ type: Schema.Literal("archive"), ...WorkspaceArchiveInput.fields }),
  Schema.Struct({ type: Schema.Literal("unarchive"), ...WorkspaceRefInput.fields }),
  Schema.Struct({ type: Schema.Literal("retry"), ...WorkspaceRefInput.fields }),
  Schema.Struct({ type: Schema.Literal("runScript"), ...WorkspaceRunScriptInput.fields }),
  Schema.Struct({ type: Schema.Literal("setProjectScripts"), scripts: ProjectWorkspaceScripts }),
]);
export type WorkspaceCommand = typeof WorkspaceCommand.Type;

export const WorkspaceCommandResult = Schema.Struct({ workspace: Schema.NullOr(Workspace) });
export type WorkspaceCommandResult = typeof WorkspaceCommandResult.Type;

export const WorkspaceStateEvent = Schema.Struct({
  workspaces: Schema.Array(Workspace),
  projectScripts: Schema.Array(ProjectWorkspaceScripts),
});
export type WorkspaceStateEvent = typeof WorkspaceStateEvent.Type;

export const FORK_WORKSPACE_WS_METHODS = {
  forkWorkspacesCommand: "fork.workspaces.command",
  forkSubscribeWorkspaces: "fork.subscribeWorkspaces",
  forkSubscribeWorkspaceLog: "fork.subscribeWorkspaceLog",
} as const;

export const ForkWorkspaceRpcs = [
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkWorkspacesCommand, {
    payload: WorkspaceCommand,
    success: WorkspaceCommandResult,
    error: Schema.Union([WorkspaceError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces, {
    payload: Schema.Struct({}),
    success: WorkspaceStateEvent,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog, {
    payload: WorkspaceRefInput,
    success: WorkspaceLogEvent,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
] as const;

export const FORK_WORKSPACE_RPC_AGGREGATES = {
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCommand]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog]: "fork-workspaces",
} as const;

/** Mutations the client checks before offering them; the server still authorizes. */
export const FORK_WORKSPACE_CLIENT_SCOPES = {
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCommand]: AuthSourceControlWriteScope,
} as const;

export const FORK_WORKSPACE_READ_SCOPES = {
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces]: AuthOrchestrationReadScope,
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog]: AuthOrchestrationReadScope,
} as const;

/**
 * The fork-owned `workspace` key in t3.json, which upstream's decoder ignores,
 * plus the upstream script fields setup falls back to.
 */
export const WorkspaceProjectFileConfig = Schema.Struct({
  workspace: Schema.optional(
    Schema.Struct({
      setup: Schema.optional(Schema.String),
      archive: Schema.optional(Schema.String),
    }),
  ),
  scripts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        command: Schema.String,
        runOnWorktreeCreate: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type WorkspaceProjectFileConfig = typeof WorkspaceProjectFileConfig.Type;

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}
