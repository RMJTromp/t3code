import {
  ProjectWorkspaceScripts,
  ThreadId,
  Workspace,
  WorkspaceError,
  type Workspace as WorkspaceType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export interface StoredWorkspace {
  readonly workspace: WorkspaceType;
  /** Threads the workspace archive closed; unarchive restores only these. */
  readonly archivedThreadIds: ReadonlyArray<ThreadId>;
  readonly log: string;
}

export class WorkspaceStore extends Context.Service<
  WorkspaceStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredWorkspace>, WorkspaceError>;
    readonly save: (record: StoredWorkspace) => Effect.Effect<void, WorkspaceError>;
    readonly listProjectScripts: Effect.Effect<
      ReadonlyArray<ProjectWorkspaceScripts>,
      WorkspaceError
    >;
    readonly saveProjectScripts: (
      scripts: ProjectWorkspaceScripts,
    ) => Effect.Effect<void, WorkspaceError>;
  }
>()("t3/fork/workspaces/WorkspaceStore") {}

/**
 * Fork migrations keep their own ledger instead of upstream's numbered
 * `Migrations/NNN_*` files, so the two sequences can never collide. Append only.
 */
const FORK_MIGRATIONS: ReadonlyArray<{
  readonly name: string;
  readonly run: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>;
}> = [
  {
    name: "001_fork_workspaces",
    run: (sql) => sql`
      CREATE TABLE IF NOT EXISTS fork_workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        archived_thread_ids_json TEXT NOT NULL DEFAULT '[]',
        log TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )
    `,
  },
  {
    name: "002_fork_project_scripts",
    run: (sql) => sql`
      CREATE TABLE IF NOT EXISTS fork_project_scripts (
        project_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
  },
];

const decodeWorkspace = Schema.decodeUnknownEffect(Schema.fromJsonString(Workspace));
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(Workspace));
const ThreadIdsJson = Schema.fromJsonString(Schema.Array(ThreadId));
const decodeThreadIds = Schema.decodeUnknownEffect(ThreadIdsJson);
const encodeThreadIds = Schema.encodeEffect(ThreadIdsJson);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const ProjectScriptsJson = Schema.fromJsonString(ProjectWorkspaceScripts);
const decodeProjectScripts = Schema.decodeUnknownEffect(ProjectScriptsJson);
const encodeProjectScripts = Schema.encodeEffect(ProjectScriptsJson);

const persistenceError = (message: string) => (cause: unknown) =>
  new WorkspaceError({
    reason: "persistence-failed",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const runForkMigrations = Effect.fn("ForkWorkspaces.runForkMigrations")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `;
  const applied = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM fork_schema_migrations`).map((row) => row.name),
  );
  for (const migration of FORK_MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* migration.run(sql);
        yield* sql`
          INSERT INTO fork_schema_migrations (name, applied_at)
          VALUES (${migration.name}, ${yield* nowIso})
        `;
      }),
    );
  }
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runForkMigrations(sql).pipe(
    Effect.mapError(persistenceError("Could not prepare the workspace table")),
  );

  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      payload_json: string;
      archived_thread_ids_json: string;
      log: string;
    }>`
      SELECT payload_json, archived_thread_ids_json, log
      FROM fork_workspaces
      ORDER BY id
    `;
    return yield* Effect.forEach(rows, (row) =>
      Effect.all({
        workspace: decodeWorkspace(row.payload_json),
        archivedThreadIds: decodeThreadIds(row.archived_thread_ids_json),
        log: Effect.succeed(row.log),
      }),
    );
  }).pipe(Effect.mapError(persistenceError("Could not read workspaces")));

  const save = (record: StoredWorkspace) =>
    Effect.gen(function* () {
      const payload = yield* encodeWorkspace(record.workspace);
      const threadIds = yield* encodeThreadIds(record.archivedThreadIds);
      const updatedAt = yield* nowIso;
      yield* sql`
        INSERT INTO fork_workspaces (
          id, project_id, payload_json, archived_thread_ids_json, log, updated_at
        )
        VALUES (
          ${record.workspace.id},
          ${record.workspace.projectId},
          ${payload},
          ${threadIds},
          ${record.log},
          ${updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          payload_json = excluded.payload_json,
          archived_thread_ids_json = excluded.archived_thread_ids_json,
          log = excluded.log,
          updated_at = excluded.updated_at
      `;
    }).pipe(Effect.mapError(persistenceError("Could not save the workspace")));

  const listProjectScripts = sql<{ payload_json: string }>`
    SELECT payload_json FROM fork_project_scripts ORDER BY project_id
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeProjectScripts(row.payload_json))),
    Effect.mapError(persistenceError("Could not read project scripts")),
  );

  const saveProjectScripts = (scripts: ProjectWorkspaceScripts) =>
    Effect.gen(function* () {
      const payload = yield* encodeProjectScripts(scripts);
      const updatedAt = yield* nowIso;
      yield* sql`
        INSERT INTO fork_project_scripts (project_id, payload_json, updated_at)
        VALUES (${scripts.projectId}, ${payload}, ${updatedAt})
        ON CONFLICT (project_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `;
    }).pipe(Effect.mapError(persistenceError("Could not save project scripts")));

  return WorkspaceStore.of({ list, save, listProjectScripts, saveProjectScripts });
});

export const layer = Layer.effect(WorkspaceStore, make);
