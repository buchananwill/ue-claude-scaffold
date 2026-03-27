# Dev Audit: Server Remote Operations — SQLite → Supabase Migration

**Scope:** Major architectural shift from local SQLite to cloud-hosted Supabase. Introduces remote command queue for dev
ops. Prerequisite for remote development workflow.

**Status:** Ready for implementation after dev audit approval. **Timeline: 5-6 hour implementation window, E2E tested
before deployment.**

---

## Motivation

**Current State:**

- Coordination server (Fastify) uses local SQLite database
- All state lives on local machine (agents, tasks, messages, builds, UBT lock, file ownership)
- Coordination cannot happen remotely — system is tightly coupled to local infrastructure

**Desired State:**

- Supabase (cloud) becomes single source of truth for all coordination data
- Local Fastify server remains but acts as **gateway/intermediary** only
- Remote user can trigger dev ops commands (git, docker, build) via admin queue
- Local system stays running, remote user monitors/coordinates from anywhere
- Enables distributed development workflow

**Business Case:**

- Unblock remote coordination capability
- Enable incident response without physical access to machine
- Prepare for multi-machine team expansion later

---

## Current Architecture Snapshot

**Data currently in SQLite:**

```
agents          (id, name, status, metadata, createdAt, lastHeartbeat)
messages        (id, channel, author, content, metadata, createdAt)
builds          (id, target, config, status, output, stderr, exitCode, createdAt)
tasks           (id, status, owner, plan, args, createdAt, claimedAt, completedAt)
ubt_lock        (lockHolder, priority, acquiredAt, ttl)
files           (path, owner, createdAt, modifiedAt)
```

**Fastify endpoints (currently SQLite-backed):**

- `/agents/register`, `/agents/{name}/status`, `/agents` — agent lifecycle
- `/messages`, `/messages/{channel}` — message board
- `/builds`, `/build`, `/test` — build orchestration + UBT host
- `/tasks/*` — task queue (claim, complete, fail)
- `/ubt/*` — UBT mutex (acquire, release, status)

**Database adapter:** better-sqlite3 (WAL mode)

---

## Proposed Architecture

**Supabase replaces SQLite as source of truth.** Fastify becomes a **thin gateway**:

```
┌─────────────────────────────────────────┐
│         Remote Client                   │
│  - Read agent status, messages, logs    │
│  - Trigger dev ops commands             │
└──────────────┬──────────────────────────┘
               │
        Supabase REST API (cloud)
               │
               ↓
┌─────────────────────────────────────────┐
│    Local Fastify Server (runs 24/7)     │
│  - Polls Supabase for commands (15s)    │
│  - Executes locally (git, docker, UBT)  │
│  - Logs all results back to Supabase    │
│  - Handles UBT mutex coordination       │
│  - Container agents still register here │
└─────────────────────────────────────────┘
```

**Data Flow:**

1. Remote client inserts command into `admin_commands` table in Supabase
2. Fastify polling loop fetches pending command, marks as `running`
3. Fastify executes command locally (subprocess + output capture)
4. Fastify updates Supabase with results (`output`, `stderr`, `status=completed`)
5. Remote client polls Supabase to read results

**Key Design Decision:** Fastify runs a **self-sufficient polling loop** (15s interval), not triggered by external
events. This makes the server autonomous — remote user just writes to the queue and reads results.

---

## Container-to-Worktree Assignment Model

**Three Distributed Boundaries:**

1. **Container** — runs Claude agents, commits work to git branch `docker/container-X`
2. **Staging Worktree** — maintains checked-out copy of container's branch, queues builds
3. **UBT** — local build tool, single instance (mutex'd across worktrees)

**Key Constraints:**

- Container ↔ Worktree: **1-to-1, required for lifetime of container** (must be coupled)
- Worktree ↔ UBT: **many-to-1** (multiple worktrees compete for one UBT)
- Worktree must be local to UBT (same machine, fast filesystem access)
- Container can be anywhere (via git commits)

**Current Setup (Implicit):**
All three (container, worktree, UBT) on same machine. Coupling is implicit in filesystem layout.

**Distributed Setup (Explicit):**
Decouple via Supabase tables. Container can be on Host-A, its worktree on Host-B (same machine as UBT).

**New Tables:**

1. **fastify_hosts** — coordinator servers (self-register on startup)
   ```sql
   CREATE TABLE fastify_hosts (
     id UUID PRIMARY KEY,
     host_name TEXT UNIQUE NOT NULL,
     url TEXT NOT NULL,
     status TEXT NOT NULL,              -- 'active', 'paused', 'offline'
     createdAt TIMESTAMP,
     lastHeartbeat TIMESTAMP
   );
   ```

2. **staging_worktrees** — build environments (one per physical host)
   ```sql
   CREATE TABLE staging_worktrees (
     id UUID PRIMARY KEY,
     worktree_name TEXT UNIQUE NOT NULL,
     fastify_host_id UUID NOT NULL REFERENCES fastify_hosts(id),
     branch_path TEXT NOT NULL,         -- docker/container-X
     status TEXT NOT NULL,              -- 'idle', 'syncing', 'building', 'failed'
     createdAt TIMESTAMP,
     lastSync TIMESTAMP
   );
   ```
   **Note:** Capacity is implicit. If host has 2 worktrees, it can support 2 concurrent containers.

3. **container_assignments** — map containers to their host manager and assigned worktree
   ```sql
   CREATE TABLE container_assignments (
     id UUID PRIMARY KEY,
     container_name TEXT UNIQUE NOT NULL,
     fastify_host_id UUID NOT NULL REFERENCES fastify_hosts(id),   -- host managing this container
     assigned_worktree_id UUID NOT NULL REFERENCES staging_worktrees(id),  -- worktree for builds
     status TEXT NOT NULL,              -- 'active', 'idle', 'failed'
     createdAt TIMESTAMP,
     lastHeartbeat TIMESTAMP
   );
   ```
   **Note:** Container references both its managing host and its assigned worktree. In current setup they're the same;
   in distributed setups they may differ.

**Workflow:**

1. **Host Registration** (on startup)
    - Fastify host registers itself: `INSERT INTO fastify_hosts (host_name, url, status)`
    - Host heartbeat: `UPDATE fastify_hosts SET lastHeartbeat = NOW()` (every 30s)

2. **Host Registers Worktrees** (on startup, after host registration)
    - Host creates worktree entries in Supabase:
      ```
      INSERT INTO staging_worktrees (worktree_name, fastify_host_id, branch_path, status)
      VALUES ('worktree-1', <host-id>, NULL, 'idle')
      VALUES ('worktree-2', <host-id>, NULL, 'idle')
      ```
    - Each worktree represents a physical staging tree on this host
    - Capacity is now explicit in the database (number of worktrees = max concurrent containers)

3. **Container Registration** (when agent starts)
    - Container requests registration: `POST /agents/register { name: 'container-A' }`
    - Fastify claims an idle worktree: `SELECT * FROM staging_worktrees WHERE status = 'idle' LIMIT 1`
    - If no idle worktree: container launch fails. (Wait for another container to shut down.)
    - If worktree found:
        - Update worktree status: `UPDATE staging_worktrees SET status = 'assigned', branch_path = 'docker/container-A'`
        - Record assignment:
          `INSERT INTO container_assignments (container_name, fastify_host_id, assigned_worktree_id, status)`
    - Container now has explicit assignment: Container-A → Worktree-1 on Host-1

4. **Container Commits** (iterative development)
    - Container commits to `docker/container-A`
    - Fastify polling loop queries assignment:
      `SELECT assigned_worktree_id FROM container_assignments WHERE container_name = 'container-A'`
    - Worktree syncs: `git fetch origin && git checkout docker/container-A`
    - Worktree queues build in `admin_commands`

5. **Build Execution**
    - UBT on Host-1 polls `admin_commands`
    - UBT builds assigned worktree
    - Results stored in Supabase

6. **Cleanup** (when container shuts down)
    - Mark assignment as `idle`: `UPDATE container_assignments SET status = 'idle'`
    - Mark worktree as `idle`: `UPDATE staging_worktrees SET status = 'idle'`
    - Worktree can be reassigned to new container, or reclaimed for disk space

**Example: Current Setup**

```
Fastify Host Registration:
  INSERT fastify_hosts (host_name, url, status)
  VALUES ('localhost:9100', 'http://localhost:9100', 'active')

Create Worktrees:
  INSERT staging_worktrees (worktree_name, fastify_host_id, branch_path, status)
  VALUES ('worktree-1', <host-id>, NULL, 'idle')
  VALUES ('worktree-2', <host-id>, NULL, 'idle')

Container A Starts:
  POST /agents/register { name: 'container-A' }
  → Fastify claims worktree-1 (idle)
  → INSERT container_assignments (container-A, host-1, worktree-1)

Container B Starts:
  POST /agents/register { name: 'container-B' }
  → Fastify claims worktree-2 (idle)
  → INSERT container_assignments (container-B, host-1, worktree-2)

Container C Requests Registration:
  POST /agents/register { name: 'container-C' }
  → Fastify queries: "SELECT * FROM staging_worktrees WHERE status = 'idle'"
  → No results (both worktrees assigned)
  → Container launch FAILS: "No available worktrees"
  → Container C must wait for Container A or B to shut down
```

**Example: Future Federated Setup**

```
Host-1 (local) registers on startup:
  INSERT fastify_hosts (host_name, url, status) → host_id_1
  INSERT staging_worktrees (worktree_name, fastify_host_id, status)
    → worktree-1, host_id_1, idle
    → worktree-2, host_id_1, idle

Host-2 (build farm) registers on startup:
  INSERT fastify_hosts (host_name, url, status) → host_id_2
  INSERT staging_worktrees (worktree_name, fastify_host_id, status)
    → worktree-1, host_id_2, idle
    → worktree-2, host_id_2, idle
    → worktree-3, host_id_2, idle
    → worktree-4, host_id_2, idle

Container A: queries idle worktrees → claims Worktree-1 on Host-1
Container B: queries idle worktrees → claims Worktree-2 on Host-1
Container C: queries idle worktrees → claims Worktree-1 on Host-2
Container D: queries idle worktrees → claims Worktree-2 on Host-2
Container E: queries idle worktrees → claims Worktree-3 on Host-2
Container F: queries idle worktrees → claims Worktree-4 on Host-2

Attempt Container G:
  → SELECT * FROM staging_worktrees WHERE status = 'idle'
  → No results (all 6 worktrees assigned)
  → Container G launch FAILS

UBT on Host-1 builds Worktree-1 or Worktree-2 (local)
UBT on Host-2 builds Worktree-1, Worktree-2, Worktree-3, Worktree-4 (local)
```

**Benefits:**

- ✅ **Explicit coupling** — database shows Container → Host → Worktree mapping
- ✅ **Capacity is implicit** — no declarations; worktrees are the inventory
- ✅ **Simple rule** — "Claim idle worktree, fail if none available"
- ✅ **Scalability** — add Host-2, create 4 worktrees on it, containers auto-claim them
- ✅ **Fault tolerance** — if Host-1 goes down, containers on Host-1 are marked failed; Host-2 keeps running
- ✅ **Observability** — dashboard shows worktree utilization per host in real-time
- ✅ **Flexible capacity** — add/remove worktrees without code changes (just SQL INSERT/DELETE)

---

**UBT Coordination Model (Paradigm Shift):**

*Current architecture (SQLite):*

- Fastify holds the UBT lock (local mutex)
- Container agents request lock from Fastify (local coordination)
- Fastify serializes: one build at a time

*Distributed architecture (Supabase):*

- **Supabase** holds the UBT lock (global queue)
- Fastify is an **executor**, not a gatekeeper
- Fastify polls Supabase: "give me the next build job to execute"
- Supabase enforces serialization: only one `admin_commands` entry with `status=running` per UBT host
- Multiple UBT hosts can exist; Supabase queues work across all of them

*Implication:*

- Fastify doesn't need to know about UBT contention (Supabase handles it)
- If Fastify crashes mid-build, the command remains in Supabase; another Fastify instance can pick it up
- Scaling to 2+ UBT hosts just means: more hosts polling the same Supabase queue, same lock semantics
- Lock discipline is **enforced at the database layer**, not the server layer

*Code impact:*

- No change to Fastify polling logic (it was already polling Supabase)
- No change to UBT execution (still runs subprocess locally)
- Just a clarification of who owns the lock: Supabase, not Fastify

---

## Implementation Plan

**Philosophy:** Build and test the new Supabase architecture in parallel to the current SQLite system. Keep the
production server running on SQLite until the new version is complete, tested, and ready to swap.

### 1. Design Supabase Schema (1 hour)

**Deliverable:** Complete schema file for Supabase (`server/schema/supabase.sql`)

**Contents:**

- Old tables (agents, messages, builds, tasks, ubt_lock, files) — exact same structure as SQLite
- New distributed architecture tables:
    - `fastify_hosts` — coordinator server inventory
    - `staging_worktrees` — build environment assignments
    - `container_assignments` — container-to-worktree mappings
    - `admin_commands` — remote operation queue
- Indexes for performance

**File:** `server/schema/supabase.sql` (single, authoritative schema definition)

**Risk:** None. Pure design phase, no deployment yet.

---

### 2. Supabase Project Setup (30 min)

**Deliverable:** Supabase project ready, schema not yet deployed.

**Steps:**

1. Use existing free-tier Supabase account
2. Create new project (or use existing; keep it separate if possible)
3. Generate API keys (anon + service role)
4. Store in `.env`:
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```
5. **Do not deploy schema yet** — we'll do that after building the new module

**Risk:** None. Just setup, no data or code changes.

---

### 3. Build Supabase Module (2-3 hours)

**Deliverable:** Parallel Fastify database module (`server/src/db-supabase.ts`)

**Philosophy:** New module implements the same interface as current `db.ts`, allowing easy swapping later.

**Steps:**

1. Install `@supabase/supabase-js`:
   ```bash
   cd server && npm install @supabase/supabase-js
   ```

2. Create `src/db-supabase.ts` (parallel to `src/db.ts`):
   ```typescript
   import { createClient } from '@supabase/supabase-js';

   const supabase = createClient(
     process.env.SUPABASE_URL!,
     process.env.SUPABASE_SERVICE_ROLE_KEY!
   );

   export const db = {
     agents: {
       register: async (name, status, metadata) => { /* ... */ },
       get: async (name) => { /* ... */ },
       list: async () => { /* ... */ },
       // ... all current agent methods
     },
     messages: {
       post: async (channel, author, content) => { /* ... */ },
       getChannel: async (channel) => { /* ... */ },
       // ... all current message methods
     },
     // ... tasks, builds, ubt_lock, files, etc.

     // New distributed architecture methods:
     hosts: {
       register: async (hostName, url) => { /* ... */ },
       heartbeat: async (hostId) => { /* ... */ },
       list: async () => { /* ... */ },
     },
     worktrees: {
       create: async (hostId, worktreeName) => { /* ... */ },
       claimIdle: async () => { /* ... */ },
       release: async (worktreeId) => { /* ... */ },
       list: async (hostId) => { /* ... */ },
     },
     containers: {
       assign: async (containerName, hostId, worktreeId) => { /* ... */ },
       getAssignment: async (containerName) => { /* ... */ },
       release: async (containerName) => { /* ... */ },
     },
     adminCommands: {
       enqueue: async (type, args) => { /* ... */ },
       dequeueNext: async (hostId) => { /* ... */ },
       complete: async (commandId, output, stderr) => { /* ... */ },
     },
   };
   ```

3. Implement methods one by one, testing as you go
4. Reuse any trivial shared logic (connection pooling, error handling, etc.)
5. Clone and modify anything that needs to change (schema mapping, async/await, etc.)

**Current server remains unchanged** (`src/db.ts` still using SQLite, all routes still working)

**Risk:** Low. Isolated module, doesn't affect current system.

---

### 4. Deploy Schema & Test Module (1 hour)

**Deliverable:** Supabase schema deployed, new module tested against it.

**Steps:**

1. Deploy schema to Supabase:
   ```bash
   psql $SUPABASE_CONNECTION_STRING < server/schema/supabase.sql
   ```
   (Or via Supabase dashboard SQL editor)

2. Run unit tests against new module:
   ```bash
   npm test src/db-supabase.test.ts
   ```

3. Test CRUD operations:
    - Insert agents, verify they appear in Supabase
    - Query messages, verify structure matches
    - Claim/release worktrees, verify state changes
    - Test admin command queue

**Risk:** Low. New module is isolated; SQLite server still running.

---

### 5. Write Migration Script (1-2 hours)

**Deliverable:** Data transformation script (`server/scripts/migrate-to-supabase.ts`)

**Steps:**

1. Read from SQLite (current data):
   ```typescript
   const oldDb = new Database('server/data.db');
   const agents = oldDb.prepare('SELECT * FROM agents').all();
   const messages = oldDb.prepare('SELECT * FROM messages').all();
   // ... all tables
   ```

2. Transform data (handle schema differences):
    - Map old column names → new column names (if any)
    - Handle data type conversions (e.g., timestamps)
    - Normalize UUIDs/IDs
    - Handle NULL → default conversions

3. Validate transformation:
    - Count rows before/after (should match)
    - Spot-check key records
    - Verify foreign key integrity (if applicable)

4. Write to Supabase:
   ```typescript
   await supabase.from('agents').insert(transformedAgents);
   await supabase.from('messages').insert(transformedMessages);
   // ... all tables
   ```

5. Make idempotent (can re-run safely without duplicating):
    - Check for existing records before inserting
    - Or: clear tables first, then insert

**Risk:** Low. Script is isolated and can be tested on copies.

---

### 6. Integration Testing (1-2 hours)

**Deliverable:** New Supabase version tested end-to-end.

**Steps:**

1. Seed Supabase with test data (via migration script on test data)
2. Start a test instance of Fastify pointing at `db-supabase.ts`
3. Run smoke tests:
    - Register agents: `POST /agents/register` → verify in Supabase
    - Post messages: `POST /messages` → verify in Supabase
    - Queue builds: `POST /build` → verify in Supabase
    - Register hosts: claim worktrees, assign containers
    - Queue admin commands: verify polling and execution

4. Run E2E tests:
    - Container registers → gets worktree assignment
    - Container commits → worktree syncs
    - Build queued → UBT executes
    - Results stored in Supabase

**Current server (SQLite) still live** — all tests on new version only.

**Risk:** Medium (if bugs found in new module, fix and re-test). No risk to production.

---

### 7. Swap Implementation (30 min)

**Deliverable:** Production server now pointing at Supabase.

**Steps:**

1. Run migration script on production data (SQLite → Supabase):
   ```bash
   npm run migrate:to-supabase
   ```

2. Verify counts in Supabase match SQLite

3. Change server import in `src/index.ts`:
   ```typescript
   // Before:
   // import db from './db';

   // After:
   import db from './db-supabase';
   ```

4. Restart server

5. Run smoke tests against new live version

6. Archive SQLite database as backup:
   ```bash
   cp server/data.db server/data.db.backup-$(date +%Y%m%d)
   ```

**Risk:** Low (data is already in Supabase; can revert by changing import back if issues found).

---

### 8. Rollback Plan (if needed)

If critical bugs found in Supabase version:

1. Change import back to `db.ts` (SQLite)
2. Restart server
3. SQLite still has all the data (it was never deleted)
4. System reverts to previous state (~2 min downtime)

**Risk:** Very low. Full rollback capability maintained until you're confident.


---

## Success Criteria

**Before Swap (New Version Ready):**

- ✅ Supabase schema designed and documented (`server/schema/supabase.sql`)
- ✅ New Fastify module built (`server/src/db-supabase.ts`)
- ✅ Module implements all agent, message, task, build, UBT methods
- ✅ New distributed architecture methods working (hosts, worktrees, containers, admin commands)
- ✅ Schema deployed to Supabase
- ✅ Unit tests pass for new module
- ✅ CRUD operations verified (agents, messages, tasks, worktrees, etc.)
- ✅ Migration script written and tested on sample data
- ✅ Integration tests pass (full workflows on new version)
- ✅ SQLite version still running and serving traffic (no changes)

**After Swap (New Version Live):**

- ✅ Migration script successfully moved data from SQLite → Supabase
- ✅ Record counts verified (all data present)
- ✅ Fastify now uses `db-supabase.ts` (changed import in `src/index.ts`)
- ✅ Server restarted and running on Supabase backend
- ✅ Smoke tests pass against new live version
- ✅ SQLite database archived as backup
- ✅ Dashboard connects to Supabase (no auth errors)
- ✅ Agents, containers, worktrees all register correctly
- ✅ Admin command queue functional
- ✅ Remote user can trigger dev ops commands via Supabase

---

## Risk Assessment

| Risk                                      | Likelihood | Impact                        | Mitigation                                                            |
|-------------------------------------------|------------|-------------------------------|-----------------------------------------------------------------------|
| New module bugs discovered during testing | Medium     | Medium (delay swap, fix bugs) | Comprehensive integration tests, no impact to production              |
| Migration script data loss                | Very Low   | High (lose state)             | Backup SQLite; verify record counts; test on sample data first        |
| Schema mismatch (old → new)               | Low        | Medium (data doesn't import)  | Validate transformation logic in migration script; spot-check records |
| Supabase is down during swap              | Very Low   | High (can't complete swap)    | Retry logic in migration script; wait for Supabase to be stable       |
| Fastify crash post-swap                   | Low        | Medium (brief downtime)       | Process monitor (e.g., PM2); auto-restart; rollback available         |
| Rollback needed post-swap                 | Low        | Low (quick revert)            | SQLite still has all data; change import back, restart (~2 min)       |

---

## Files to Create/Modify

**New Files:**

- `server/schema/supabase.sql` — Complete Supabase schema (old + new tables)
- `server/src/db-supabase.ts` — New Fastify module (Supabase backend)
- `server/src/db-supabase.test.ts` — Unit tests for new module
- `server/scripts/migrate-to-supabase.ts` — Data transformation script (SQLite → Supabase)

**Modified Files:**

- `server/src/index.ts` — Change import (only after swap): `import db from './db-supabase'`
- `.env` — Add Supabase credentials (after project setup)

**Unchanged Files:**

- `server/src/db.ts` — SQLite module remains untouched (fallback/archive)
- All route handlers — Work with either `db.ts` or `db-supabase.ts` (same interface)

**New ENV Variables:**

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## Testing Checklist

- [ ] Supabase schema created; tables visible in dashboard
- [ ] Data migration: record counts match (agents, messages, builds, tasks, etc.)
- [ ] Fastify connects to Supabase (no auth errors in logs)
- [ ] All endpoints tested locally: agents, messages, tasks, builds, UBT lock
- [ ] Polling loop starts on server startup (log message confirms)
- [ ] Admin command inserted → Fastify picks it up within 15s
- [ ] Command executes: `status` returns server info
- [ ] Command output stored in Supabase
- [ ] E2E test passes (full command lifecycle)
- [ ] Multiple commands execute in FIFO order
- [ ] Concurrent commands handled correctly (no conflicts)
- [ ] Timeout + kill logic works (long-running command terminates)
- [ ] Dashboard loads without errors (can read Supabase data)
- [ ] Container agents still register and report status
- [ ] Server runs stable for 30+ minutes
- [ ] Logs show no errors, warnings, or auth failures

---

## Implementation Timeline

| Phase     | Task                                 | Duration       | Status                |
|-----------|--------------------------------------|----------------|-----------------------|
| 1         | Design Supabase schema               | 1 hour         | Ready                 |
| 2         | Setup Supabase project + credentials | 30 min         | Ready                 |
| 3         | Build db-supabase.ts module          | 2-3 hours      | Ready                 |
| 4         | Deploy schema + unit tests           | 1 hour         | Ready                 |
| 5         | Write migration script               | 1-2 hours      | Ready                 |
| 6         | Integration testing (new version)    | 1-2 hours      | Ready                 |
| 7         | Swap implementation (cutover)        | 30 min         | Ready                 |
| 8         | Verify + archive                     | 30 min         | Ready                 |
| **Total** |                                      | **7-10 hours** | **Go/No-go decision** |

**Realistic window:** 7-10 hours spread over 1-2 days (can be parallel work, not blocking). Build new version while
keeping current system live.

**Parallel work possible:**

- Design schema (step 1) while setting up project (step 2)
- Build module (step 3) while designing migration script (step 5)
- Test new module (step 4) while developing integration tests (step 6)

---

## Notes for Review

- **Breaking change:** SQLite → Supabase is a major architectural shift. Requires testing and audit before deployment.
- **Rollback available:** Can revert to SQLite if critical bugs found (keep backup).
- **No forced downtime:** Can migrate during development window; test afterwards.
- **Remote-first design:** Architecture enables remote coordination; prioritizes reliability over local convenience.
- **Future enhancements:** Rate limiting, command retries, scheduled commands, audit logging (post-launch).
