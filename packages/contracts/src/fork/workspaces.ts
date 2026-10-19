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

export const WorkspaceListEvent = Schema.Array(Workspace);
export type WorkspaceListEvent = typeof WorkspaceListEvent.Type;

export const WorkspaceArchivedThreads = Schema.Array(ThreadId);

export const FORK_WORKSPACE_WS_METHODS = {
  forkWorkspacesCreate: "fork.workspaces.create",
  forkWorkspacesArchive: "fork.workspaces.archive",
  forkWorkspacesUnarchive: "fork.workspaces.unarchive",
  forkWorkspacesRetry: "fork.workspaces.retry",
  forkSubscribeWorkspaces: "fork.subscribeWorkspaces",
  forkSubscribeWorkspaceLog: "fork.subscribeWorkspaceLog",
} as const;

const WorkspaceRpcError = Schema.Union([WorkspaceError, EnvironmentAuthorizationError]);

export const ForkWorkspaceRpcs = [
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkWorkspacesCreate, {
    payload: WorkspaceCreateInput,
    success: Workspace,
    error: WorkspaceRpcError,
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkWorkspacesArchive, {
    payload: WorkspaceArchiveInput,
    success: Workspace,
    error: WorkspaceRpcError,
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkWorkspacesUnarchive, {
    payload: WorkspaceRefInput,
    success: Workspace,
    error: WorkspaceRpcError,
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkWorkspacesRetry, {
    payload: WorkspaceRefInput,
    success: Workspace,
    error: WorkspaceRpcError,
  }),
  Rpc.make(FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces, {
    payload: Schema.Struct({}),
    success: WorkspaceListEvent,
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
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCreate]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesArchive]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesUnarchive]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesRetry]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaces]: "fork-workspaces",
  [FORK_WORKSPACE_WS_METHODS.forkSubscribeWorkspaceLog]: "fork-workspaces",
} as const;

/** Mutations the client checks before offering them; the server still authorizes. */
export const FORK_WORKSPACE_CLIENT_SCOPES = {
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesCreate]: AuthSourceControlWriteScope,
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesArchive]: AuthSourceControlWriteScope,
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesUnarchive]: AuthSourceControlWriteScope,
  [FORK_WORKSPACE_WS_METHODS.forkWorkspacesRetry]: AuthSourceControlWriteScope,
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
