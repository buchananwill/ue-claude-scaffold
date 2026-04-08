# Schema hardening V2.5 — surrogate agent PKs, full FKs, soft-delete

This plan is split across one file per phase in this directory. Execute phases in strict numerical order; each assumes every prior phase is complete. Commit boundaries are at each operator's discretion, but the full plan lands on a single branch and merges once.

## Context

The multi-tenancy migration gave every data table a `project_id text` column but never upgraded the schema to treat `(project_id, name)` as load-bearing. `agents.name` is a global primary key (`server/src/schema/tables.ts:19`), every cross-table reference to an agent is a plain text column without a constraint, and every `project_id` column lacks an FK to `projects`. The result was observed on 2026-04-08: `agent-1` in project A shut down during an idle pump timeout, its `_shutdown` called `DELETE /agents/agent-1` with no project scope, and the unconditional `tasksLifecycleQ.releaseByAgent('agent-1')` released an active task belonging to `agent-1` in project B.

This plan folds together three overdue repairs into one migration:

1. Surrogate UUID v7 primary key on `agents`, with `unique(project_id, name)`. Every cross-table reference to an agent becomes a single-column FK on the UUID.
2. Agent rows are never hard-deleted in normal operation. A new `status = 'deleted'` soft-delete state replaces row removal. Real purges become a rare vacuum-class operation, out of scope here. This eliminates audit trail corruption risk and removes any need for "name-at-time-of-write" denormalization on historical tables.
3. Full foreign key adoption across all 9 data tables — both `project_id` FKs to `projects` (absorbing `plans/project-id-foreign-keys.md` into this effort) and agent FKs throughout. `ON DELETE RESTRICT` is the default; the database itself enforces the integrity the application layer was supposed to but didn't.

All work lands on a single branch in a single container run. Merge once; revert whole if needed. No compatibility shims, no phased rollout, no backwards compatibility for old text references.

**Driver neutrality:** `server/src/drizzle-instance.ts` is already a dual-driver dispatch — node-postgres when `DATABASE_URL` is set (the path a future Supabase deployment takes), PGlite otherwise (local dev and tests). The schema module, migration files, and query code are shared. Every change in this plan applies identically to both drivers through the same `server/drizzle/*.sql` migration files. No driver switch is required for this work.

## Design decisions (locked — do not re-evaluate mid-execution)

**Surrogate PK type:** native `uuid` column named `id` on `agents`, holding a UUID v7 value generated application-side via the `uuid` npm package (v11+). Rationale: PGlite supports the native `uuid` type in core (verified: it stores as uuid, `pg_typeof` reports `uuid`, and format is enforced at insert). Real Postgres and Supabase support it trivially. Generation stays in JS — application-side for symmetry between drivers, and because PGlite has no `pg_uuidv7` extension. UUID v7 is time-ordered so B-tree index locality stays healthy.

**Soft-delete:** add the value `'deleted'` to the set of valid `agents.status` values. `status` remains `text` (no enum). The documented valid values become: `idle | working | done | error | paused | stopping | deleted`. `DELETE /agents/:name` flips `status` to `deleted` and releases transient claims (files, tasks, ubt locks) but leaves the row in place. The row's FK references from `messages`, `build_history`, etc. remain intact.

**Unique constraint on `(project_id, name)`:** enforced even for soft-deleted rows. A new container registering `agent-1` in a project where an older `agent-1` is in `status = 'deleted'` must either reject or deliberately reactivate the existing row. The register path will reactivate — flipping status back to `idle`, rotating `session_token`, and updating `container_host` — rather than inserting a new row. This prevents audit trail spoofing: the historical agent-1 is the same row, tracked continuously across its lifetime, never two distinct UUIDs.

**FK semantics:** `ON DELETE RESTRICT` for every FK added in this pass. `ON DELETE CASCADE` is reserved for the future vacuum tooling and is not used here. The only exception is `task_files` / `task_dependencies` within-table references, which were never broken and retain their existing `ON DELETE CASCADE` if any (verify during Phase 2).

**Name-at-time-of-write columns:** not added. Soft-delete obviates the need.

**`room_members` polymorphism (eliminated, not papered over):** audit of the codebase on 2026-04-08 revealed that the `room_members.member = 'user'` row is **write-only dead data**. It is inserted at two sites (`server/src/routes/agents.ts:74` direct-room creation, `server/src/queries/teams.ts:64` team room creation) and is never read — the dashboard fetches rooms by project without filtering on membership (`dashboard/src/hooks/useRooms.ts:12`), and no server query joins on `member = 'user'`. The operator is *not* actually a participant in the room — they are an author of some messages and a viewer of all rooms on the local server.

Accordingly, `room_members` becomes **agent-only**:
```
room_members (
  id           uuid primary key,
  room_id      text not null references rooms(id) on delete restrict,
  agent_id     uuid not null references agents(id) on delete restrict,
  joined_at    timestamp default now(),
  unique (room_id, agent_id)
)
```
No CHECK constraint. No partial unique indexes. No nullable FK. No polymorphism. No `member` text column. The two `'user'` insert sites are deleted outright as dead code.

The operator's authorship of messages is instead expressed on `chat_messages` via a typed discriminator:
```
chat_messages (
  id                 serial primary key,  -- unchanged
  room_id            text not null references rooms(id) on delete restrict,
  author_type        text not null check (author_type in ('agent', 'operator', 'system')),
  author_agent_id    uuid references agents(id) on delete restrict,
  content            text not null,
  reply_to           integer references chat_messages(id) on delete set null,
  created_at         timestamp default now(),
  check (
    (author_type = 'agent' and author_agent_id is not null)
    or (author_type in ('operator', 'system') and author_agent_id is null)
  )
)
```
The old `sender text` column is replaced by `author_type` + `author_agent_id`. For agent messages, the server resolves the display name via a join to `agents.name`. For operator and system messages, the display name is a constant ("user" or "system") rendered by the server response layer.

This separates two orthogonal concerns the old schema was conflating: *room membership* (who is a participant) and *message authorship* (who wrote this). Agents are both. The operator is only the latter.

**`agent_type` column on `agents`:** out of scope for this plan. Listed as a follow-up. Adding it later is a simple column addition and does not require another schema rewrite.

**Historical data:** preserved via a staged backfill migration (detailed in Phase 3). The migration file runs identically on PGlite (local) and node-postgres/Supabase (future hosted), so the data-preservation semantics must be correct for both. Wiping is not acceptable — a destructive migration file becomes a permanent landmine in the migration history.

**Orphan handling policy** — the current schema has no FK integrity, so any migration that adds FKs will find dangling references (agent names that were hard-deleted, cross-project name collisions from the PK bug, `project_id = 'default'` values with no matching project). The policy per table is:

- **Live-state orphans** (`tasks.claimed_by`, `files.claimant`, `ubt_lock.holder`, `ubt_queue.agent`): NULL out the claim / delete the lock / delete the queue entry. The referenced work becomes unclaimed and re-queueable. No data loss that matters — these are transient claims.
- **Membership orphans** (`team_members.agent_name`, agent rows in `room_members`): DELETE the membership row. Empty team or empty agent-side room membership is recoverable; a dangling reference is not. `room_members` operator rows (`member = 'user'`) are DELETEd outright as dead write-only data.
- **Historical orphans** (`messages.agent`, `build_history.agent`): **keep the row**. Add the new nullable `agent_id uuid` column, leave it NULL for orphaned rows, and retain the old `agent text` column on these two tables as a display-only legacy field. This preserves the audit trail. New rows going forward populate `agent_id`; the old text column becomes redundant for new writes but stays valid for old writes. This is the one exception to the "drop old columns" rule.
- **`chat_messages` orphans**: `sender` value that referenced a since-deleted agent is classified as `author_type = 'system'` with NULL `author_agent_id`. Row content preserved; original sender name lost (acceptable for a handful of pre-migration orphans).
- **`project_id` orphans**: absorbs the cleanup logic from `plans/project-id-foreign-keys.md`. Rows with `project_id = 'default'` (or any other unknown project) in child tables get DELETEd before the `project_id` FK constraints are added. `agents` rows with unknown `project_id` get soft-deleted to `status = 'deleted'` rather than removed, so any historical references survive.

All orphan counts are logged before deletion so the operator can eyeball what is about to happen when the migration runs.

## Phases

1. [Dependencies and audit](01-dependencies-and-audit.md) — install `uuid` package, audit every current cross-table reference, produce scratch audit file.
2. [Schema declarations in tables.ts](02-schema-declarations.md) — all Drizzle schema changes: agents UUID PK, FK-carrying column renames, room_members agent-only, chat_messages author_type discriminator.
3. [Migration SQL files](03-migration-sql-files.md) — hand-write `0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql`.
4. [Apply migration to local DB](04-apply-migration.md) — snapshot data dir, run `db:migrate`, verify post-migration state.
5. [Agents query layer](05-agents-queries.md) — rewrite `server/src/queries/agents.ts` with project scoping, soft-delete, UUID generation, reactivation.
6. [Agent-referencing query layer](06-agent-referencing-queries.md) — rewrite `tasks-lifecycle.ts`, `files.ts`, `coalesce.ts`, `ubt.ts` to take `projectId` and `agentId`.
7. [Rooms and chat query layer](07-rooms-and-chat-queries.md) — Option D: agent-only `room_members`, chat `author_type` discriminator, `isAgentMember`, computed `sender` field on reads.
8. [Agents routes](08-routes-agents.md) — scoped queries, session-token DELETE check, soft-delete semantics, direct-room creation fix.
9. [Rooms routes and team launcher](09-routes-rooms-and-team-launcher.md) — operator short-circuit in `routes/rooms.ts`, delete dead `'user'` membership inserts, fix `team-launcher.ts` author.
10. [Integration — remaining callsites](10-integration-callsites.md) — update `git-utils.ts`, `routes/build.ts`, `routes/tasks-claim.ts`, `routes/teams.ts` for the new query signatures.
11. [Container shutdown session token](11-container-session-token.md) — `container/lib/registration.sh` appends `?sessionToken=` to its DELETE; confirms no chat-channel.mjs changes needed.
12. [Test updates and new regression/chat-protocol tests](12-tests.md) — update existing tests, add cross-project isolation + session-token + reactivation + operator-author regression tests.
13. [Verification and documentation](13-verification-and-docs.md) — `npm run typecheck`, `npm test`, shell syntax, update `CLAUDE.md`, delete absorbed plans, commit.
14. [Operator rebuild and smoke test](14-operator-smoke-test.md) — `docker compose build`, snapshot, launch two same-named agents in different projects, verify cross-project isolation and chat protocol end-to-end.

## Top-level acceptance criteria

These are cross-phase invariants. Per-phase acceptance criteria are in each phase file.

- Two containers in different projects with the same agent name coexist without interfering at any stage of their lifetimes.
- `agents.id` is a UUID v7 stored in the native `uuid` column type, and is the sole primary key of the agents table.
- A unique constraint on `(project_id, name)` is enforced in the schema, including for soft-deleted rows.
- Every cross-table reference to an agent is a FK on `agents.id` with `ON DELETE RESTRICT`.
- Every data table's `project_id` is a FK on `projects.id` with `ON DELETE RESTRICT`.
- `agents.status` may take the value `'deleted'`. `DELETE /agents/:name` sets this value rather than removing the row.
- `DELETE /agents/:name` rejects mismatched `sessionToken` values with `409`.
- `DELETE /agents` (bulk) is scoped to the caller's `projectId` and is soft-delete.
- `server/src/queries/agents.ts` exports no `getProjectId`, `hardDelete`, or `deleteAll`.
- `server/src/queries/rooms.ts` has no `'user'` string sentinels; `addMember` takes an agent UUID, not a string.
- `server/src/queries/chat.ts` has no `sender` parameter on `sendMessage`; it takes `authorType` and `authorAgentId` instead.
- `server/src/routes/rooms.ts` POST `/rooms/:id/messages` distinguishes operator and agent callers by the presence of `X-Agent-Name`; the operator path skips the membership check and writes `author_type = 'operator'`.
- `room_members.member` column does not exist. `chat_messages.sender` column does not exist. Both are replaced by typed columns with FKs and CHECK constraints.
- `plans/project-id-foreign-keys.md` is deleted; its intent is documented in this plan.
- `CLAUDE.md` reflects the new invariants.
- **Container code is unchanged for chat protocol.** `container/mcp-servers/chat-channel.mjs` is not touched; the agent's view of the chat HTTP contract is preserved end-to-end (room discovery, polling, check_messages, reply, check_presence). Verified on 2026-04-08 via end-to-end trace.
- **Data preservation:** no table is wiped. Live-state tables (`tasks`, `files`, `ubt_lock`, `ubt_queue`, `team_members`) may have orphaned rows removed per the orphan policy. `room_members` loses all operator rows (intentional — dead write-only data) and any agent rows that failed to resolve to a valid `agents.id`. Historical tables (`messages`, `build_history`) retain all rows with `agent_id` populated where resolvable and NULL where orphaned. `chat_messages` retains all rows; orphaned authorship is classified as `'system'`. Audit trail is preserved where data integrity permits.
- **Migration file is re-runnable against any Postgres backend:** the three migration files apply identically on PGlite and on a future Supabase deployment. No destructive `DELETE FROM` of non-orphaned data; no environment-specific branches.

## Explicitly out of scope

- `agent_type` observability column on `agents`. Follow-up: simple ALTER TABLE.
- Vacuum / compaction tooling for truly removing soft-deleted agents and their historical references. Follow-up: a small CLI tool that takes a retention policy and a date cutoff, archives, and hard-deletes with cascades in a transaction.
- Dashboard UI changes to surface the `deleted` status. Follow-up: small UI update to show deleted agents in a "History" section.
- A dedicated `operators` table (Option B from the design evaluation). The current local-single-operator model does not justify it. If/when the scaffold becomes multi-operator, the migration is straightforward: create `operators(id, name)`, add `author_operator_id uuid REFERENCES operators(id)` to `chat_messages`, extend the CHECK constraint.
- A full `participants` table unification (Option C from the design evaluation). Much larger refactor with no current motivating benefit.
- Any reconsideration of `messages.agent` semantics if it turns out to be a free-form label rather than an agent reference — that decision is made in Phase 2 based on field semantics discovered during the audit in Phase 1.
