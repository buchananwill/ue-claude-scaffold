# Async DB Adapter Migration Plan

**Scope:** Introduce an async adapter interface between the Fastify server and the database backend. Wrap SQLite in this interface first, then implement a Supabase backend behind the same interface. Server always boots; SQLite is the default; Supabase is opt-in.

**Status:** Plan approved. Ready for implementation.

**Supersedes:** The implementation strategy in `plans/audit-server-remote-ops.md` (which proposed a parallel `db-supabase.ts` module with a single-swap cutover). This plan replaces that approach with an incremental adapter migration that keeps the server compilable and testable after every commit.

---

## Lessons from the First Attempt

The engineering team's first attempt to integrate Supabase failed for two reasons:

1. **No graceful fallback.** The Supabase integration was not opt-out by default. When Supabase credentials were missing or the connection failed, the server could not boot. The server must always be able to start and serve the sibling project, regardless of Supabase availability.

2. **Sync/async impedance mismatch.** SQLite access via `better-sqlite3` is synchronous. The Supabase client is async-only. Routes that called `db.prepare(...).get()` inline could not simply swap to `await supabase.from(...).select(...)` without restructuring every call site. The correct approach: wrap SQLite calls in async functions first (which resolve immediately since the underlying call is sync), then build the Supabase adapter behind the same async interface.

---

## Design Decisions

### D1: Adapter with typed filter-param methods (not a query builder)

~8 places in the codebase construct SQL dynamically (messages list/count, tasks list, builds list, files list, rooms list, teams list, chat history). These become adapter methods with typed option objects:

```typescript
interface MessageListOptions {
  channel: string;
  type?: string;
  fromAgent?: string;
  since?: number;
  before?: number;
  limit?: number;
}
messages: {
  list(opts: MessageListOptions): Promise<MessageRow[]>;
  count(opts: { channel: string; type?: string; fromAgent?: string }): Promise<number>;
}
```

Each backend builds queries natively — SQLite constructs parameterized SQL strings, Supabase uses its chained filter API. No intermediate query builder. The duplication (both backends encoding filter logic) is the accepted cost of supporting two backends via an adapter. A builder-for-a-builder would be a premature abstraction solving a problem that barely exists.

### D2: Compositional logic lives in the adapter's backend-agnostic layer

Some operations compose multiple queries (e.g. `linkFilesToTask`, `checkAndClaimFiles` in `tasks-files.ts`). These belong in one of two places:

- **In SQL itself** (preferred) — if the composition can be expressed as a single statement or a stored procedure/CTE, it should be. The database planning engine has full knowledge to execute this efficiently.
- **In a backend-agnostic adapter layer** — if SQL can't express it cleanly, the adapter exposes component operations from each backend, and a shared layer composes them. This keeps composition logic DRY across backends.

The adapter interface therefore has two layers:
```
DbAdapter (interface — what routes call)
  ├── Backend-agnostic composition methods
  │     └── calls backend-specific primitives
  └── Backend-specific primitives
        ├── SqliteAdapter (sync calls wrapped in async)
        └── SupabaseAdapter (native async)
```

### D3: Transactions are no-op wrappers for Supabase (for now)

SQLite transactions wrap `db.transaction()`. Supabase has no client-side transaction API. For now, `adapter.tx()` on the Supabase backend is a no-op — individual operations are assumed atomic. If multi-step atomicity becomes critical for Supabase, we add server-side RPC/stored procedures later.

### D4: Global singleton pattern (same as current `db`)

The adapter is exported as a module-level singleton, matching the existing `import { db } from '../db.js'` pattern. No Fastify decorator, no dependency injection. Routes change from:

```typescript
import { db } from '../db.js';
const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
```

To:

```typescript
import { adapter } from '../create-adapter.js';
const row = await adapter.agents.getByName(name);
```

---

## Current State Snapshot

**Database:** SQLite via `better-sqlite3`, WAL mode, schema at v12.

**Tables (14):** schema_version, agents, ubt_lock, ubt_queue, build_history, messages, tasks, files, task_files, task_dependencies, rooms, room_members, chat_messages, teams, team_members.

**Usage:** ~89 `db.prepare()` calls across 16 route files. No abstraction layer. All routes import the global `db` singleton directly.

**Route files by DB complexity:**

| Route file | Statements | Transactions | Dynamic SQL | Domain |
|---|---|---|---|---|
| tasks-files.ts | 26 | via callers | no | tasks, files, deps |
| agents.ts | 15 | yes | no | agents, rooms |
| rooms.ts | 14 | yes | yes | rooms, chat |
| teams.ts | 14 | yes | yes | teams, rooms |
| ubt.ts | 13 | yes | no | ubt, builds |
| coalesce.ts | 11 | yes | no | coalesce |
| messages.ts | 8 | yes | yes | messages |
| tasks.ts | 7 | yes | yes | tasks |
| tasks-claim.ts | 5 | yes | no | tasks claim |
| tasks-replan.ts | 4 | yes | no | tasks replan |
| build.ts | 2 | no | no | ubt, agents |
| search.ts | 3 | no | no | search |
| builds.ts | 1 | no | yes | builds |
| files.ts | 1 | no | yes | files |
| sync.ts | 1 | no | no | agents |
| health.ts | 0 | no | no | — |

---

## Phase 1: Foundation

No behavior change. No route changes. Server continues to run on raw `db` imports.

### 1.1 Extract shared row types into `server/src/db-types.ts`

`AgentRow` currently lives in `agents.ts`. `TaskRow` lives in `tasks-types.ts`. Message, build, file, room, chat, team row types exist only implicitly. This commit:

- Creates `server/src/db-types.ts` with explicit interfaces for every table's row shape.
- Updates `agents.ts` and `tasks-types.ts` to re-export from `db-types.ts` (or import from it).
- No logic changes. All existing tests pass.

### 1.2 Define the `DbAdapter` interface in `server/src/db-adapter.ts`

Pure type definitions. One sub-interface per domain:

- `AgentsAdapter` — register, getAll, getByName, updateStatus, delete, deleteAll, getWorktree, getByToken, getActiveNames
- `TasksAdapter` — insert, getById, list, patch, deleteByStatus
- `TasksClaimAdapter` — claimNextCandidate, countPending, countBlocked, countDepBlocked
- `TasksReplanAdapter` — getNonTerminalTasks, getNonTerminalDeps, markCycle, setPriority
- `TasksLifecycleAdapter` — claim, updateProgress, complete, fail, release, reset, integrate, integrateBatch, integrateAll, getCompletedByAgent, getAllCompleted
- `TaskFilesAdapter` — insertFile, linkFileToTask, getFilesForTask, deleteFilesForTask, claimFilesForAgent, getFileConflicts, getFileConflictsForTask
- `TaskDepsAdapter` — insertDep, getDepsForTask, getIncompleteBlockers, getWrongBranchBlockers, deleteDepsForTask
- `MessagesAdapter` — insert, list, count, claim, resolve, deleteById, deleteByChannel, deleteByChannelBefore
- `UbtAdapter` — getLock, acquireLock, releaseLock, enqueue, dequeue, getQueue, getQueuePosition, findInQueue, isAgentRegistered
- `BuildsAdapter` — insertHistory, updateHistory, avgDuration, lastCompleted, list
- `FilesAdapter` — list (with optional claimant/unclaimed filter)
- `RoomsAdapter` — createRoom, getRoom, listRooms, deleteRoom, addMember, removeMember, getMembers, getPresence
- `ChatAdapter` — sendMessage, getHistory, isMember
- `TeamsAdapter` — create, getById, list, dissolve, updateStatus, updateDeliverable, delete, getMembers
- `CoalesceAdapter` — countActiveTasks, countActiveTasksForAgent, countPendingTasks, countClaimedFiles, getOwnedFiles, pausePumpAgents, getInFlightTasks, releaseAllFiles, resumePausedAgents, getPausedAgentNames
- `SearchAdapter` — searchTasks, searchMessages, searchAgents
- `TxAdapter` — transaction(fn): wraps multiple operations in an atomic unit

Top-level `DbAdapter` composes all sub-interfaces.

No implementation. Imports row types from `db-types.ts`.

### 1.3 Create `server/src/sqlite-adapter.ts` — skeleton

- Class `SqliteAdapter implements DbAdapter`.
- Constructor takes `Database.Database` (the `better-sqlite3` instance).
- All methods throw `new Error('not implemented')`.
- Export factory: `createSqliteAdapter(db): DbAdapter`.

### 1.4 Create `server/src/create-adapter.ts` — adapter factory + global

- Reads `DB_BACKEND` env var (default: `'sqlite'`).
- `sqlite`: calls `openDb()` from `db.ts`, wraps in `createSqliteAdapter()`.
- `supabase`: throws `new Error('Supabase adapter not yet implemented. Set DB_BACKEND=sqlite or remove the variable.')`.
- Exports `let adapter: DbAdapter` and `async function initAdapter(): Promise<DbAdapter>`.

---

## Phase 2: Implement SQLite adapter

One domain per commit. Each commit adds real method bodies to `SqliteAdapter`, moving the SQL from route files' patterns into the adapter. The route files are NOT changed yet — the adapter methods are written but not called.

Tests may be added per domain to validate the adapter methods directly (optional but recommended for complex domains).

### 2.1 `agents` domain

Methods: register, getAll, getByName, updateStatus, delete, deleteAll, getWorktree, getByToken, getActiveNames.

Prepared statements migrated from `agents.ts`: insertAgent, allAgents, updateStatus, getAgent, deleteAgent, deleteAllAgents, plus the inline `SELECT worktree`, `SELECT name`, `SELECT 1 FROM rooms` queries.

Note: agent registration has a side-effect of creating a direct-message room. This is composition logic — it calls `agents.register()` + `rooms.createRoom()` + `rooms.addMember()`. This composition lives in the backend-agnostic layer (or remains in the route handler, since it's cross-domain orchestration).

### 2.2 `messages` domain

Methods: insert, list (with MessageListOptions), count, claim, resolve, deleteById, deleteByChannel, deleteByChannelBefore.

Dynamic SQL for `list` and `count` moves into the adapter. The SQLite adapter builds the parameterized SQL string internally based on the options object.

### 2.3 `ubt` + `builds` domain

Methods on UbtAdapter: getLock, acquireLock, releaseLock, enqueue, dequeue, getQueue, getQueuePosition, findInQueue, isAgentRegistered.

Methods on BuildsAdapter: insertHistory, updateHistory, avgDuration, lastCompleted, list (with optional agent/type/since filters).

These are tightly coupled — `acquireLock` and `releaseLock` involve transactions that touch both `ubt_lock` and `ubt_queue`. The transaction logic stays in the SQLite adapter as a single atomic method.

### 2.4 `files` domain

Methods: list (with optional claimant or unclaimed filter).

One dynamic query. Smallest domain.

### 2.5 `tasks` core

Methods: insert, getById, list (with status/limit filter), patch (dynamic UPDATE), deleteByStatus.

The `list` and `patch` methods handle dynamic SQL internally.

### 2.6 `taskFiles` + `taskDeps`

Methods on TaskFilesAdapter: insertFile, linkFileToTask, getFilesForTask, deleteFilesForTask, claimFilesForAgent, getFileConflicts, getFileConflictsForTask.

Methods on TaskDepsAdapter: insertDep, getDepsForTask, getIncompleteBlockers, getWrongBranchBlockers, deleteDepsForTask.

These map directly from the prepared statements in `tasks-files.ts`.

### 2.7 `tasksClaim`

Methods: claimNextCandidate, countPending, countBlocked, countDepBlocked.

The `claimNextCandidate` query is the most complex in the codebase — a SELECT with COUNT(CASE...), JOINs, and subqueries. It stays as a single SQL statement in the SQLite adapter.

### 2.8 `tasksReplan`

Methods: getNonTerminalTasks, getNonTerminalDeps, markCycle, setPriority.

The replan transaction (mark cycles + update priorities in bulk) is a composition that lives in the backend-agnostic layer, calling the primitive methods.

### 2.9 `tasksLifecycle`

Methods: claim, updateProgress, complete, fail, release, reset, integrate, integrateBatch, integrateAll, getCompletedByAgent, getAllCompleted.

Direct mapping from `tasks-files.ts` shared statements.

### 2.10 `rooms` + `chat`

Methods on RoomsAdapter: createRoom, getRoom, listRooms, deleteRoom, addMember, removeMember, getMembers, getPresence.

Methods on ChatAdapter: sendMessage, getHistory (with before/after cursor pagination), isMember.

Dynamic SQL for `listRooms` (optional member filter) and `getHistory` (before/after/latest modes) moves into adapter.

### 2.11 `teams`

Methods: create, getById, list (with optional status filter), dissolve, updateStatus, updateDeliverable, delete, getMembers.

Team creation is a transaction that also creates a room — this is cross-domain composition that stays in the backend-agnostic layer or in the route handler.

### 2.12 `coalesce`

Methods: countActiveTasks, countActiveTasksForAgent, countPendingTasks, countClaimedFiles, getOwnedFiles, pausePumpAgents, getInFlightTasks, releaseAllFiles, resumePausedAgents, getPausedAgentNames.

The `releaseAllFiles` + `resumePausedAgents` transaction is a composition method.

### 2.13 `search`

Methods: searchTasks, searchMessages, searchAgents. All take a query string and limit.

### 2.14 `tx` — transaction wrapper

- SQLite: wraps `db.transaction(fn)`, calls `fn()` synchronously inside the transaction.
- Supabase (future): no-op, calls `fn()` directly.

---

## Phase 3: Wire adapter into server and migrate routes

### 3.0 Wire adapter into `index.ts`

- Replace `openDb(dbPath)` with `await initAdapter()`.
- The global `adapter` is now initialized.
- The global `db` still exists (used internally by `SqliteAdapter`). Routes still import `db` directly — both paths work.
- All tests pass. No behavior change.

### Route migration order

Each commit changes one route file:
- Remove `import { db } from '../db.js'`
- Add `import { adapter } from '../create-adapter.js'`
- Replace all `db.prepare(...).run/get/all(...)` with `await adapter.domain.method(...)`
- Remove prepared statement declarations from module/plugin scope
- Ensure handler functions are `async` (most already are)

Order is simplest-first to build confidence, complex last:

| Commit | Route file | Statements | Notes |
|---|---|---|---|
| 3.1 | health.ts | 0 | No DB calls. Canary — verifies import pattern. |
| 3.2 | files.ts | 1 | Simplest real migration. |
| 3.3 | search.ts | 3 | No transactions. |
| 3.4 | builds.ts | 1 | Dynamic query. |
| 3.5 | sync.ts | 1 | Single query. |
| 3.6 | messages.ts | 8 | First route with transactions. |
| 3.7 | build.ts | 2 | Uses ubt + agents adapter methods. |
| 3.8 | coalesce.ts | 11 | Multiple domains, transactions. |
| 3.9 | ubt.ts | 13 | Lock acquire/release transactions. |
| 3.10 | agents.ts | 15 | Transactions, room creation side-effect. |
| 3.11 | rooms.ts | 14 | Dynamic queries, transactions. |
| 3.12 | teams.ts | 14 | Cross-domain (creates rooms). |
| 3.13 | tasks-files.ts | 26 | Refactor `initTasksSharedStatements` — this is the big one. The shared statement factory transforms into a set of adapter method calls. Helper functions (`linkFilesToTask`, `checkAndClaimFiles`, etc.) become backend-agnostic composition methods in the adapter or stay as route-level orchestration calling adapter primitives. |
| 3.14 | tasks-claim.ts | 5 | Complex claim query. |
| 3.15 | tasks-replan.ts | 4 | Replan transaction. |
| 3.16 | tasks-lifecycle.ts | — | Uses shared statements (already migrated in 3.13). |
| 3.17 | tasks.ts | 7 | Main tasks route. Depends on 3.13–3.16. |

### 3.18 Clean up dead `db` imports

After all routes are migrated, no route file imports `db` directly. This commit:
- Removes the `export let db` from `db.ts` (or makes it non-exported).
- `db.ts` still exports `openDb()` — used internally by `SqliteAdapter`.
- Verifies no route file references `db` directly.

### 3.19 Update test helper

`test-helper.ts` creates isolated Fastify instances with temp SQLite DBs. Update to go through `initAdapter()` so tests exercise the adapter path. All existing tests pass through the adapter.

---

## Phase 4: Supabase adapter

No production impact. SQLite remains default. All work is additive.

### 4.1 Install `@supabase/supabase-js`, add env vars to `.env.example`

New env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

### 4.2 Create `server/schema/supabase.sql`

Full schema matching all 14 SQLite tables + indexes. Single authoritative file.

### 4.3 Create `server/src/supabase-adapter.ts` — skeleton

Class `SupabaseAdapter implements DbAdapter`. All methods throw `new Error('not implemented')`.

### 4.4–4.17 Implement each domain

Mirrors Phase 2 (2.1–2.14). One domain per commit. Each uses the Supabase JS client's native API.

### 4.18 Wire into `create-adapter.ts`

When `DB_BACKEND=supabase`:
- Validate env vars are present. If missing, log error and fall back to SQLite.
- Attempt Supabase connection. If it fails, log error and fall back to SQLite.
- If connection succeeds, instantiate `SupabaseAdapter`.

The server always boots. Supabase failure is never fatal.

### 4.19 Create migration script

`server/scripts/migrate-to-supabase.ts` — reads all rows from SQLite, transforms as needed, writes to Supabase. Idempotent (can re-run safely).

---

## Phase 5: Swap and verify

### 5.1 Deploy Supabase schema, run migration script
### 5.2 Test with `DB_BACKEND=supabase` against live instance
### 5.3 Switch production config, reboot, verify
### 5.4 Monitor — SQLite remains available as instant rollback (`DB_BACKEND=sqlite`)

---

## Commit discipline

Every commit in this plan:
- Passes `npm run typecheck`
- Passes `npm test`
- Does not change server behavior (until Phase 3, where behavior is identical but routes use the adapter)
- Has a clear, reversible scope

No commit leaves the code in a half-migrated state where some routes use the adapter and the adapter methods they call don't exist yet. Phase 2 (implement adapter) completes before Phase 3 (migrate routes) begins.
