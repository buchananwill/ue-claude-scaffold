# Drizzle ORM Migration Plan

**Scope:** Replace all raw `better-sqlite3` database access with Drizzle ORM, using a Postgres-native schema. Local dev
and tests use PGlite (in-process WASM Postgres). Production uses `node-postgres` connecting to Supabase. One schema, one
query implementation, two drivers.

**Status:** Plan approved. Ready for container-orchestrator execution.

**Supersedes:** `plans/async-db-adapter-migration.md` — that plan proposed a hand-written adapter interface with dual
SQLite/Supabase implementations. This plan replaces that approach with Drizzle ORM, which eliminates the
dual-implementation burden and provides type-safe queries that work across drivers.

---

## Motivation

1. **Testability.** The first Supabase integration attempt failed because it required a live connection. Mocking the
   Supabase client is verbose and provides no contractual certainty. PGlite gives real Postgres semantics in-process —
   no Docker, no network, no mocks.

2. **Single code path.** Instead of maintaining two query implementations (SQLite + Postgres), Drizzle compiles one set
   of typed queries to the correct dialect for whichever driver is active.

3. **Type safety.** The current codebase has 130+ `db.prepare()` calls with manually typed `as` casts on results.
   Drizzle infers row types from the schema definition — no casts, no drift.

4. **Cloud readiness.** The end state: set `DATABASE_URL` to a Supabase connection string and the server runs on hosted
   Postgres. Omit it and the server runs on PGlite with local file storage. No code changes between modes.

---

## Design Decisions

### D1: Postgres-only (no dual SQLite/Postgres schema)

The original plan maintained SQLite as a backend. This plan drops SQLite entirely:

- **Schema defined once** using `drizzle-orm/pg-core` (`pgTable`).
- **Local dev** uses PGlite (`@electric-sql/pglite`) — real Postgres running in-process via WASM. Persists to a local
  directory (`./data/pglite/`), replacing `coordination.db`.
- **Tests** use PGlite in-memory (ephemeral, no cleanup needed).
- **Production** uses `node-postgres` (`pg`) connecting to Supabase or any Postgres host.

Trade-off: loses the zero-dep simplicity of SQLite for local dev. Gains: no dual-schema maintenance, real Postgres
semantics everywhere (JSON operators, transactions, types), and test/prod parity.

### D2: Query modules, not a hand-written adapter

No `DbAdapter` interface. No `SqliteAdapter`/`SupabaseAdapter` classes. Instead:

- **Schema** in `server/src/schema/tables.ts` — Drizzle table definitions.
- **Query modules** in `server/src/queries/*.ts` — one file per domain (agents, tasks, messages, etc.). Each exports
  async functions that take a Drizzle instance and parameters.
- **Routes** import query functions and call them with the global Drizzle instance.

This is thinner than an adapter layer and lets Drizzle handle dialect translation.

### D3: Transactions are real everywhere

PGlite and `node-postgres` both support real Postgres transactions. No "no-op wrapper" compromise. The`db.transaction()`
API works identically across both drivers:

```typescript
await db.transaction(async (tx) => {
    await tx.update(tasks).set({status: 'claimed'}).where(eq(tasks.id, id));
    await tx.update(files).set({claimant: agent}).where(eq(files.path, path));
});
```

### D4: PGlite replaces SQLite for local persistence

The coordination server currently stores state in `coordination.db` (SQLite file). After migration:

- **No `DATABASE_URL`** env var: server creates a PGlite instance backed by `./data/pglite/` directory. Same zero-config
  experience — just runs.
- **`DATABASE_URL` set**: server connects to that Postgres instance via `pg.Pool`.

### D5: JSON columns become `jsonb`

The `result` and `payload` columns currently store JSON as `TEXT`. In the Drizzle schema these become `jsonb`, giving
native Postgres JSON operators. The 7 `json_extract(col, '$.key')` calls become `sql`\``${col}->>'key'`\` — standard
Postgres, works in both PGlite and production.

### D6: Supabase RLS compatibility

Drizzle connects via standard Postgres wire protocol. RLS is enforced at the database level regardless of query origin.
Initial deployment uses `service_role` credentials (bypasses RLS — the server enforces its own access control via
`project_id` filtering). RLS policies can be added later as defense-in-depth for multi-tenant isolation without any
Drizzle changes.

### D7: Project ID middleware

The current codebase extracts `project_id` from `X-Project-Id` header manually in every route (~15 locations). This
migration adds a Fastify `preHandler` hook that:

1. Reads `X-Project-Id` header (defaults to `'default'`).
2. Validates against the `/^[a-zA-Z0-9_-]{1,64}$/` pattern.
3. Attaches to `request.projectId` via Fastify decorator.

All query module functions accept `projectId` as a parameter.

---

## Current State Snapshot

**Schema version:** 13. **Tables:** 14 (agents, ubt_lock, ubt_queue, build_history, messages, tasks, files, task_files,
task_dependencies, rooms, room_members, chat_messages, teams, team_members, plus schema_version).

**`db.prepare()` calls:** 130 across 15 route files. 10 additional in test files (used for test setup/assertions, not
production code).

| Route file      | Calls | Transactions | Dynamic SQL | JSON operators |
|-----------------|-------|--------------|-------------|----------------|
| tasks-files.ts  | 26    | via callers  | no          | yes (2)        |
| agents.ts       | 17    | yes          | no          | no             |
| rooms.ts        | 16    | yes          | yes         | no             |
| teams.ts        | 14    | yes          | yes         | no             |
| ubt.ts          | 13    | yes          | no          | no             |
| coalesce.ts     | 11    | yes          | no          | no             |
| messages.ts     | 9     | yes          | yes         | no             |
| tasks-claim.ts  | 6     | yes          | no          | yes (5)        |
| tasks.ts        | 5     | yes          | yes         | no             |
| tasks-replan.ts | 4     | yes          | no          | no             |
| build.ts        | 3     | no           | no          | no             |
| search.ts       | 3     | no           | no          | no             |
| files.ts        | 1     | no           | yes         | no             |
| builds.ts       | 1     | no           | yes         | no             |
| sync.ts         | 1     | no           | no          | no             |

**Project isolation status (pre-migration):**

- Tables WITH `project_id`: agents, tasks, files, ubt_lock, ubt_queue, build_history.
- Tables WITHOUT `project_id`: messages, rooms, teams.
- Child tables (room_members, chat_messages, team_members): inherit project scope via FK to parent.

**Schema invariant for the Drizzle schema:** Every parent table has a `project_id TEXT NOT NULL DEFAULT 'default'` column. No exceptions. This is a hard requirement for multi-tenant cloud deployment, not an incremental nice-to-have.

**Dependencies to add:** `drizzle-orm`, `drizzle-kit`, `@electric-sql/pglite`, `pg`, `@types/pg`.
**Dependencies to remove:** `better-sqlite3`, `@types/better-sqlite3`, `@supabase/supabase-js` (present but unused).

---

## Phase 1: Foundation

No behavior change. No route changes. Server continues to run on raw `db` imports. All existing tests pass after each
commit.

### 1.1 Install dependencies

```bash
npm install drizzle-orm @electric-sql/pglite pg
npm install -D drizzle-kit @types/pg
```

Do NOT remove `better-sqlite3` yet — the existing code still depends on it. Removal happens in Phase 5.

Add `drizzle.config.ts` at `server/drizzle.config.ts`:

```typescript
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
    schema: './src/schema/tables.ts',
    out: './drizzle',
    dialect: 'postgresql',
});
```

### 1.2 Define Drizzle schema

Create `server/src/schema/tables.ts` with `pgTable` definitions for all 14 tables. The schema must exactly match the
current SQLite schema semantics:

**Tables to define:**

1. `agents` — PK: `name`. Columns: project_id (text, not null, default 'default'), worktree, plan_doc, status (text,
   default 'idle'), mode (text, default 'single'), registered_at (timestamp, default now), container_host,
   session_token (unique).

2. `ubtLock` — PK: `project_id` (default 'default'). Columns: holder, acquired_at (timestamp), priority (integer,
   default 0).

3. `ubtQueue` — PK: `id` (serial). Columns: project_id (text, not null, default 'default'), agent (text, not null),
   priority (integer, default 0), requested_at (timestamp, default now).

4. `buildHistory` — PK: `id` (serial). Columns: project_id, agent, type (text, check build/test), started_at (timestamp,
   default now), duration_ms (integer), success (integer), output (text), stderr (text).

5. `messages` — PK: `id` (serial). Columns: from_agent, channel, type, payload (jsonb), claimed_by, claimed_at,
   resolved_at, result (text), created_at. Indexes: channel, (channel, id), claimed_by.

6. `tasks` — PK: `id` (serial). Columns: project_id, title, description, source_path, acceptance_criteria, status (text,
   check 7 values, default 'pending'), priority, base_priority, claimed_by, claimed_at, completed_at, result (jsonb),
   progress_log, created_at. Indexes: status, (priority desc, id asc).

7. `files` — Composite PK: (project_id, path). Columns: claimant, claimed_at.

8. `taskFiles` — Composite PK: (task_id, file_path). FK: task_id references tasks. Index: file_path.

9. `taskDependencies` — Composite PK: (task_id, depends_on). FKs to tasks. Check: task_id != depends_on. Indexes:
   task_id, depends_on.

10. `rooms` — PK: `id` (text). Columns: name, type (check: group/direct), created_by, created_at.

11. `roomMembers` — Composite PK: (room_id, member). FK: room_id references rooms (cascade). Columns: joined_at.

12. `chatMessages` — PK: `id` (serial). FK: room_id references rooms (cascade), reply_to self-ref. Columns: sender,
    content, created_at. Index: (room_id, id).

13. `teams` — PK: `id` (text). Columns: name, brief_path, status (check: active/converging/dissolved, default 'active'),
    deliverable, created_at, dissolved_at.

14. `teamMembers` — Composite PK: (team_id, agent_name). FK: team_id references teams (cascade). Columns: role,
    is_leader (integer, default 0). Partial unique index: one leader per team.

Create `server/src/schema/index.ts` that re-exports all tables.

**Key type mappings (SQLite -> Postgres via Drizzle):**

- `INTEGER PRIMARY KEY AUTOINCREMENT` -> `serial().primaryKey()`
- `TEXT` -> `text()`
- `DATETIME DEFAULT CURRENT_TIMESTAMP` -> `timestamp().defaultNow()`
- `INTEGER` -> `integer()`
- JSON-as-TEXT columns (`result`, `payload`) -> `jsonb()`

**Verification:** Run `npx drizzle-kit generate` — it should produce a migration SQL file. Inspect it to confirm it
matches the current schema semantics. Existing tests still pass (schema file is not wired in yet).

### 1.3 Create driver factory

Create `server/src/drizzle-instance.ts`:

```typescript
import {drizzle as drizzlePg} from 'drizzle-orm/node-postgres';
import {drizzle as drizzlePglite} from 'drizzle-orm/pglite';
import {PGlite} from '@electric-sql/pglite';
import {Pool} from 'pg';
import {migrate} from 'drizzle-orm/pglite/migrator'; // or node-postgres/migrator
import * as schema from './schema/index.js';

export type DrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;

let _db: DrizzleDb;

export async function initDrizzle(opts?: { databaseUrl?: string; dataDir?: string }): Promise<DrizzleDb> {
    const databaseUrl = opts?.databaseUrl ?? process.env.DATABASE_URL;

    if (databaseUrl) {
        // Production: connect to Postgres (Supabase or other host)
        const pool = new Pool({connectionString: databaseUrl});
        _db = drizzlePg(pool, {schema});
    } else {
        // Local dev / test: PGlite (in-process Postgres)
        const dataDir = opts?.dataDir; // undefined = in-memory (for tests)
        const client = new PGlite(dataDir);
        _db = drizzlePglite(client, {schema}) as unknown as DrizzleDb;
    }

    // Run migrations
    await migrate(_db, {migrationsFolder: './drizzle'});

    return _db;
}

export function getDb(): DrizzleDb {
    if (!_db) throw new Error('Database not initialized. Call initDrizzle() first.');
    return _db;
}
```

**Type note:** PGlite and node-postgres Drizzle instances have slightly different types but identical runtime APIs. The
`as unknown as DrizzleDb` cast is a known Drizzle pattern for this. Alternatively, define `DrizzleDb` as the union type
if the cast feels fragile — verify at this step which approach the Drizzle version supports cleanly.

**Verification:** Write a smoke test that calls `initDrizzle()` with no args (PGlite in-memory), runs a migration,
inserts a row, reads it back. This validates the schema + driver + migration pipeline end-to-end. Existing tests still
pass.

### 1.4 Add `project_id` to remaining tables

Before migrating queries, complete project isolation. Add `project_id TEXT NOT NULL DEFAULT 'default'` to:

- `messages` (with index)
- `rooms`
- `room_members` (via room's project, or directly)
- `chat_messages` (via room's project, or directly)
- `teams`
- `team_members` (via team's project, or directly)

Design choice: `rooms` and `teams` are the parent entities. Add `project_id` to `rooms` and `teams`. Child tables (
`room_members`, `team_members`, `chat_messages`) inherit project scope via their FK relationship — no `project_id`column
needed on children.

Include these columns in the Drizzle schema from step 1.2. For the current SQLite DB, add a v14 migration in `db.ts` so
existing tests continue to work during the transition period (Phases 2-4 where both old and new code coexist).

**Verification:** Existing tests pass. New columns exist with default values.

---

## Phase 2: Query Modules

One domain per commit. Each commit adds a query module in `server/src/queries/`. The module exports async functions that
use Drizzle. Routes are NOT changed yet — the query modules exist alongside the old code and are tested independently.

Each query module follows this pattern:

```typescript
import {eq, and, sql, desc, asc} from 'drizzle-orm';
import {agents} from '../schema/tables.js';
import type {DrizzleDb} from '../drizzle-instance.js';

export async function getAgentByName(db: DrizzleDb, projectId: string, name: string) {
    const [row] = await db.select().from(agents)
        .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
    return row ?? null;
}
```

Every function takes `db: DrizzleDb` as its first argument (enables testing with isolated PGlite instances) and
`projectId` where applicable.

### Query module order and scope

Each sub-step below is one commit. Include tests for each module in a colocated `server/src/queries/*.test.ts` file that
creates a PGlite instance, runs migrations, and exercises the queries.

| Step | Module               | Functions                                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                        |
|------|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2.1  | `agents.ts`          | register, getAll, getByName, updateStatus, softDelete, hardDelete, deleteAll, getByToken, getActiveNames                                                                                     | Registration side-effect (DM room creation) is NOT in this module — that's cross-domain composition handled at the route level.                                                                                                                              |
| 2.2  | `messages.ts`        | insert, list (with filter options), count, claim, resolve, deleteById, deleteByChannel, deleteByChannelBefore                                                                                | `list` and `count` use Drizzle's dynamic `where()` chaining for optional filters.                                                                                                                                                                            |
| 2.3  | `ubt.ts`             | getLock, acquireLock, releaseLock, enqueue, dequeue, getQueue, getQueuePosition, findInQueue                                                                                                 | Lock acquire/release are transactions.                                                                                                                                                                                                                       |
| 2.4  | `builds.ts`          | insertHistory, updateHistory, avgDuration, lastCompleted, list (with optional filters)                                                                                                       | `list` uses dynamic `where()`.                                                                                                                                                                                                                               |
| 2.5  | `files.ts`           | list (with optional claimant/unclaimed filter)                                                                                                                                               | Smallest domain.                                                                                                                                                                                                                                             |
| 2.6  | `tasks-core.ts`      | insert, getById, list (with status/limit), patch (dynamic update), deleteByStatus, deleteById                                                                                                | `patch` builds a dynamic `set()` from the options object.                                                                                                                                                                                                    |
| 2.7  | `task-files.ts`      | insertFile, linkFileToTask, getFilesForTask, deleteFilesForTask, claimFilesForAgent, getFileConflicts, getFileConflictsForTask                                                               | Direct mapping from `initTasksSharedStatements` file/claim operations.                                                                                                                                                                                       |
| 2.8  | `task-deps.ts`       | insertDep, getDepsForTask, getIncompleteBlockers, getWrongBranchBlockers, deleteDepsForTask                                                                                                  | The `getWrongBranchBlockers` query uses JSON operators: `tasks.result->>'agent'` instead of `json_extract(result, '$.agent')`.                                                                                                                               |
| 2.9  | `tasks-claim.ts`     | claimNextCandidate, countPending, countBlocked, countDepBlocked                                                                                                                              | `claimNextCandidate` is the most complex query — CTEs, LEFT JOINs, NOT EXISTS subqueries, JSON operators. Use Drizzle's `sql` tagged template for this query rather than fighting the query builder. Verify output matches current SQLite query row-for-row. |
| 2.10 | `tasks-lifecycle.ts` | claim, updateProgress, complete, fail, release, reset, integrate, integrateBatch, integrateAll, getCompletedByAgent, getAllCompleted                                                         | `integrateBatch` and `getCompletedByAgent` use `result->>'agent'` JSON operator.                                                                                                                                                                             |
| 2.11 | `tasks-replan.ts`    | getNonTerminalTasks, getNonTerminalDeps, markCycle, setPriority                                                                                                                              | Replan transaction (mark cycles + update priorities in bulk).                                                                                                                                                                                                |
| 2.12 | `rooms.ts`           | createRoom, getRoom, listRooms, deleteRoom, addMember, removeMember, getMembers, getPresence                                                                                                 | `listRooms` has optional member filter (dynamic query).                                                                                                                                                                                                      |
| 2.13 | `chat.ts`            | sendMessage, getHistory (before/after cursor pagination), isMember                                                                                                                           | `getHistory` has three modes: before cursor, after cursor, latest.                                                                                                                                                                                           |
| 2.14 | `teams.ts`           | create, getById, list (optional status filter), dissolve, updateStatus, updateDeliverable, delete, getMembers                                                                                | Team creation transaction also creates a room — cross-domain composition.                                                                                                                                                                                    |
| 2.15 | `coalesce.ts`        | countActiveTasks, countActiveTasksForAgent, countPendingTasks, countClaimedFiles, getOwnedFiles, pausePumpAgents, getInFlightTasks, releaseAllFiles, resumePausedAgents, getPausedAgentNames | Multi-table reads and writes.                                                                                                                                                                                                                                |
| 2.16 | `search.ts`          | searchTasks, searchMessages, searchAgents                                                                                                                                                    | Uses `ILIKE` (Postgres, case-insensitive) instead of `LIKE` (SQLite).                                                                                                                                                                                        |

### Composition helpers

Some route-level operations compose multiple query-module calls. These are NOT query module code — they live either in
the route handler or in a thin `server/src/queries/composition.ts` module:

- `linkFilesToTask(db, taskId, files, projectId)` — calls `insertFile` + `linkFileToTask` in a loop.
- `linkDepsToTask(db, taskId, depIds)` — calls `insertDep` in a loop.
- `checkAndClaimFiles(db, taskId, agent)` — reads file conflicts, claims if clear.
- `formatTaskWithFiles(db, row, agent)` — aggregates files, deps, blockers, reasons.
- `blockReasonsForTask(db, config, row, agent)` — orchestrates multiple queries + git checks.

Utility functions from `tasks-files.ts` that don't touch the DB (`hasValue`, `validateFilePaths`, `unknownFields`) move
to `server/src/utils.ts`.

---

## Phase 3: Route Migration

Each commit changes one route file. The commit:

1. Removes `import { db } from '../db.js'` and all `db.prepare()` calls.
2. Imports query functions from `server/src/queries/*.js`.
3. Imports `getDb` from `drizzle-instance.js` (or receives db via Fastify decorator — see 3.0).
4. Replaces all inline SQL with query function calls.
5. Ensures all handler functions are `async` (most already are).
6. Passes `request.projectId` where applicable.

### 3.0 Wire Drizzle into server startup and add project_id middleware

In `server/src/index.ts`:

- Replace `openDb(dbPath)` with `await initDrizzle({ dataDir: './data/pglite' })` (or `DATABASE_URL` from env).
- Keep `openDb()` call temporarily — both systems coexist during migration.

Add project_id middleware. Create `server/src/plugins/project-id.ts`:

```typescript
import type {FastifyPluginAsync} from 'fastify';

const projectIdPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.decorateRequest('projectId', 'default');

    fastify.addHook('preHandler', async (request) => {
        const raw = (request.headers['x-project-id'] as string) || 'default';
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) {
            throw fastify.httpErrors.badRequest(`Invalid project ID: "${raw}"`);
        }
        request.projectId = raw;
    });
};

export default projectIdPlugin;
```

Register this plugin in `index.ts` before route plugins. Add TypeScript declaration merging for `request.projectId`.

**Verification:** Both `openDb()` and `initDrizzle()` run at startup. All existing tests pass. The middleware doesn't
break existing routes (they still read headers manually; gradual switchover happens per-route).

### Route migration order (simplest first)

| Step | Route file      | Calls | Notes                                                                                                                                                                                                                                                                                                                                                 |
|------|-----------------|-------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 3.1  | health.ts       | 0     | No DB calls. Canary — verifies import pattern works. Update dbPath reference to reflect new storage.                                                                                                                                                                                                                                                  |
| 3.2  | files.ts        | 1     | Single dynamic query.                                                                                                                                                                                                                                                                                                                                 |
| 3.3  | search.ts       | 3     | No transactions. Switch `LIKE` to `ILIKE`.                                                                                                                                                                                                                                                                                                            |
| 3.4  | builds.ts       | 1     | Single dynamic query.                                                                                                                                                                                                                                                                                                                                 |
| 3.5  | sync.ts         | 1     | Single query.                                                                                                                                                                                                                                                                                                                                         |
| 3.6  | build.ts        | 3     | Uses ubt + agents queries.                                                                                                                                                                                                                                                                                                                            |
| 3.7  | messages.ts     | 9     | First route with transactions. Dynamic list/count.                                                                                                                                                                                                                                                                                                    |
| 3.8  | tasks-replan.ts | 4     | Replan transaction.                                                                                                                                                                                                                                                                                                                                   |
| 3.9  | coalesce.ts     | 11    | Multi-domain reads + writes.                                                                                                                                                                                                                                                                                                                          |
| 3.10 | ubt.ts          | 13    | Lock acquire/release transactions. Also migrate `sweepStaleLock`.                                                                                                                                                                                                                                                                                     |
| 3.11 | agents.ts       | 17    | Transactions, DM room creation side-effect.                                                                                                                                                                                                                                                                                                           |
| 3.12 | rooms.ts        | 16    | Dynamic queries, transactions.                                                                                                                                                                                                                                                                                                                        |
| 3.13 | teams.ts        | 14    | Cross-domain (creates rooms on team creation).                                                                                                                                                                                                                                                                                                        |
| 3.14 | tasks-files.ts  | 26    | **The big one.** Dismantle `initTasksSharedStatements()`. Replace the prepared-statement factory with imports from query modules (tasks-core, task-files, task-deps, tasks-lifecycle). Composition helpers move to `queries/composition.ts`. The `TasksSharedStatements` interface is eliminated — routes import individual query functions directly. |
| 3.15 | tasks-claim.ts  | 6     | Complex `claimNextCandidate`. Depends on 3.14.                                                                                                                                                                                                                                                                                                        |
| 3.16 | tasks.ts        | 5     | Main tasks route. Depends on 3.14.                                                                                                                                                                                                                                                                                                                    |

### 3.17 Update existing tests

Each route's `.test.ts` file needs updating to use the Drizzle test infrastructure:

- Replace `openDb(dbPath)` in test helpers with `initDrizzle()` (PGlite in-memory).
- Replace any `db.prepare()` calls in test setup/assertions with Drizzle queries.
- Tests that construct raw SQL for setup can use `db.execute(sql`...`)` via Drizzle's raw SQL.

This can be done incrementally per route (each route commit updates its own tests) or as a batch at the end. *
*Recommendation:** update tests per route commit so that each commit is self-contained and green.

---

## Phase 4: Cleanup

### 4.1 Remove old database code

- Delete the `SCHEMA_SQL` constant and all migration code from `server/src/db.ts`.
- `db.ts` exports nothing. If any test utilities still reference `openDb`, update them.
- Delete `server/src/db.ts` entirely if no longer imported anywhere.
- Remove the `schema_version` table from the Drizzle schema (Drizzle has its own migration tracking in the `drizzle`
  directory).

### 4.2 Remove stale dependencies

```bash
npm uninstall better-sqlite3 @types/better-sqlite3 @supabase/supabase-js
```

Run `npm run typecheck` and `npm test` — any remaining references to these packages are compile errors that must be
fixed.

### 4.3 Update test helper

Rewrite `server/src/test-helper.ts`:

```typescript
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import Fastify, {type FastifyInstance} from 'fastify';
import sensible from '@fastify/sensible';
import * as schema from './schema/index.js';
import type {DrizzleDb} from './drizzle-instance.js';

export interface TestContext {
    app: FastifyInstance;
    db: DrizzleDb;
    cleanup: () => void;
}

export async function createTestApp(): Promise<TestContext> {
    const client = new PGlite(); // in-memory
    const db = drizzle(client, {schema});
    await migrate(db, {migrationsFolder: './drizzle'});

    const app = Fastify({logger: false});
    await app.register(sensible);

    const cleanup = () => {
        // PGlite in-memory instances are GC'd — no file cleanup needed
    };

    return {app, db, cleanup};
}
```

Test context now provides `db: DrizzleDb` instead of `dbPath: string`. Tests that need direct DB access for
setup/assertions use the Drizzle instance.

### 4.4 Clean up `initTasksSharedStatements` remnants

After Phase 3.14-3.16, the `TasksSharedStatements` interface and `initTasksSharedStatements` function should be dead
code. Remove them from `tasks-files.ts`. If the file is empty afterward, delete it and update the barrel export in
`routes/index.ts`.

### 4.5 Final verification

Run the full suite:

```bash
npm run typecheck
npm test
npm run build
```

Confirm no imports of `better-sqlite3`, `@supabase/supabase-js`, or `../db.js` remain in any route or query file. Grep
for `db.prepare` — should return zero results outside of git history.

---

## Phase 5: Production Readiness

### 5.1 Connection pooling configuration

When `DATABASE_URL` is set, the driver factory creates a `pg.Pool`. Add configuration:

```typescript
const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,                  // max connections (Supabase free tier: 60)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});
```

Expose pool metrics via the `/health` endpoint:

```json
{
  "db": {
    "backend": "postgres",
    "pool": {
      "total": 20,
      "idle": 18,
      "waiting": 0
    }
  }
}
```

For PGlite, the health response reports `"backend": "pglite"` with no pool stats.

### 5.2 Graceful shutdown

In `index.ts`, on `SIGTERM`/`SIGINT`:

1. Stop accepting new requests (`server.close()`).
2. Drain the connection pool (`pool.end()`).
3. Exit.

### 5.3 Environment configuration

Update `.env.example`:

```env
# Database — omit for local PGlite, set for Postgres/Supabase
# DATABASE_URL=postgresql://postgres:[password]@[host]:5432/postgres

# Supabase-specific (for RLS, optional)
# SUPABASE_ANON_KEY=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

Update `scaffold.config.example.json` if any database paths are referenced there.

### 5.4 Migration tooling

Add npm scripts:

```json
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/migrate.ts",
  "db:studio": "drizzle-kit studio"
}
```

Create `server/src/migrate.ts` — a standalone script that runs Drizzle migrations against `DATABASE_URL` (or PGlite).
Used for initial Supabase schema provisioning:

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

### 5.5 Data migration script (SQLite -> Postgres)

Create `server/scripts/migrate-sqlite-to-postgres.ts`:

- Opens the old `coordination.db` via `better-sqlite3` (as a one-time dev dependency or standalone).
- Reads all rows from each table.
- Transforms as needed (TEXT JSON -> jsonb, datetime strings -> timestamps).
- Inserts into the Drizzle-managed Postgres via `DATABASE_URL`.
- Idempotent (uses `ON CONFLICT DO NOTHING`).

This is a one-time utility for migrating existing local data to Supabase. Not needed for fresh deployments.

### 5.6 Supabase-specific SQL (optional)

If RLS is desired later, create `server/schema/rls-policies.sql`:

```sql
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE
POLICY "agents_project_isolation" ON agents
  USING (project_id = current_setting('app.project_id', true));
-- ... repeat for other tables
```

This is NOT part of the Drizzle migration — it's applied manually via the Supabase dashboard or SQL editor. Document it
but don't automate it yet.

### 5.7 Final end-to-end verification

1. `npm test` — all 324+ server tests pass via PGlite.
2. `npm run build` — clean TypeScript compile.
3. `npm run dev` — server starts with PGlite locally, serves all endpoints.
4. `DATABASE_URL=<supabase-url> npm run db:migrate` — provisions schema on Supabase.
5. `DATABASE_URL=<supabase-url> npm run dev` — server starts against Supabase, serves all endpoints.
6. Dashboard connects and displays data from both backends.

---

## Commit Discipline

Every commit in this plan:

- Passes `npm run typecheck`.
- Passes `npm test`.
- Does not change server behavior (HTTP API contracts are identical).
- Has a clear, reversible scope.

No commit leaves the code in a state where routes reference query modules that don't exist, or where imports are broken.
Phases 2 (query modules) and 3 (route migration) can proceed in parallel per domain if desired, but the commit order
within each phase is sequential.

---

## Risk Notes

### PGlite maturity

PGlite is actively developed by ElectricSQL. It supports most Postgres features but may have edge cases with advanced
features (e.g., `LISTEN/NOTIFY`, custom extensions). The queries in this codebase use standard SQL — JOINs, CTEs, JSON
operators, transactions — all of which PGlite handles. If a PGlite gap is discovered during implementation, the fallback
is to use Docker Postgres for tests (same queries, different driver setup in test-helper).

### `json_extract` -> `->>'key'` migration

The 7 `json_extract(result, '$.agent')` calls must become `result->>'agent'` (or Drizzle's `sql` equivalent). These are
in `tasks-claim.ts` (5 occurrences) and `tasks-files.ts` (2 occurrences). Both are covered in Phase 2.8-2.10. The
Drizzle `sql` tagged template makes this straightforward:

```typescript
sql`${tasks.result}->>'agent'`
```

### Complex query: `claimNextCandidate`

This query (in `tasks-claim.ts`) uses CTEs, LEFT JOINs, NOT EXISTS subqueries, COUNT(CASE...), and JSON operators. It is
the highest-risk query to migrate. Recommendation: implement it as a raw `sql` tagged template in the Drizzle query
module rather than trying to express it via the query builder. Write a dedicated test that creates a realistic task
graph (with deps, file locks, multiple agents) and verifies the candidate ordering matches the current SQLite behavior.

### Transition period (Phases 2-4)

During migration, both `openDb()` (SQLite) and `initDrizzle()` (PGlite) run at startup. Routes are migrated one at a
time. This means the server temporarily has two database connections. This is intentional — it allows incremental
migration with green tests at every commit. The SQLite connection is removed in Phase 4.

### Dashboard compatibility

The dashboard polls the coordination server's HTTP API. Since the API contracts don't change, the dashboard requires
zero modifications.
