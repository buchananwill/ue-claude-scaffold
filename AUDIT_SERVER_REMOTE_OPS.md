# Dev Audit: Server Remote Operations — SQLite → Supabase Migration

**Scope:** Major architectural shift from local SQLite to cloud-hosted Supabase. Introduces remote command queue for dev ops. Prerequisite for remote development workflow.

**Status:** Ready for implementation after dev audit approval. **Timeline: TODAY (2026-03-27), E2E tested before departure.**

---

## Motivation

**Current State:**
- Coordination server (Fastify) uses local SQLite database
- All state lives on local machine (agents, tasks, messages, builds, UBT lock, file ownership)
- User cannot coordinate remotely — must be present at machine

**Desired State:**
- Supabase (cloud) becomes single source of truth for all coordination data
- Local Fastify server remains but acts as **gateway/intermediary** only
- Remote user can trigger dev ops commands (git, docker, build) via admin queue
- Local system stays running, remote user monitors/coordinates from anywhere
- User departing for one week; needs this infrastructure before leaving

**Business Case:**
- Unblock distributed development workflow
- Enable remote incident response (e.g., trigger builds, view logs remotely)
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
│         Remote Client (user away)       │
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

**Key Design Decision:** Fastify runs a **self-sufficient polling loop** (15s interval), not triggered by external events. This makes the server autonomous — remote user just writes to the queue and reads results.

---

## Implementation Plan

### 1. Supabase Setup (30 min)

**Deliverable:** Supabase project with schema deployed.

**Steps:**
1. Use existing free-tier Supabase account
2. Create SQL schema (tables + indexes):
   ```sql
   -- Agents
   CREATE TABLE agents (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name TEXT UNIQUE NOT NULL,
     status TEXT NOT NULL,
     metadata JSONB,
     createdAt TIMESTAMP DEFAULT NOW(),
     lastHeartbeat TIMESTAMP
   );

   -- Messages
   CREATE TABLE messages (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     channel TEXT NOT NULL,
     author TEXT NOT NULL,
     content TEXT NOT NULL,
     metadata JSONB,
     createdAt TIMESTAMP DEFAULT NOW()
   );

   -- Builds
   CREATE TABLE builds (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     target TEXT NOT NULL,
     config TEXT NOT NULL,
     status TEXT NOT NULL,
     output TEXT,
     stderr TEXT,
     exitCode INT,
     createdAt TIMESTAMP DEFAULT NOW()
   );

   -- Tasks
   CREATE TABLE tasks (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     status TEXT NOT NULL,
     owner TEXT,
     plan TEXT,
     args JSONB,
     createdAt TIMESTAMP DEFAULT NOW(),
     claimedAt TIMESTAMP,
     completedAt TIMESTAMP
   );

   -- UBT Lock
   CREATE TABLE ubt_lock (
     lockHolder TEXT PRIMARY KEY,
     priority INT,
     acquiredAt TIMESTAMP DEFAULT NOW(),
     ttl INT
   );

   -- Files
   CREATE TABLE files (
     path TEXT PRIMARY KEY,
     owner TEXT,
     createdAt TIMESTAMP DEFAULT NOW(),
     modifiedAt TIMESTAMP
   );

   -- Admin Commands (new)
   CREATE TABLE admin_commands (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     type TEXT NOT NULL,
     args JSONB,
     status TEXT NOT NULL DEFAULT 'pending',
     output TEXT,
     stderr TEXT,
     createdAt TIMESTAMP DEFAULT NOW(),
     startedAt TIMESTAMP,
     completedAt TIMESTAMP
   );

   -- Indexes
   CREATE INDEX idx_messages_channel ON messages(channel);
   CREATE INDEX idx_tasks_status ON tasks(status);
   CREATE INDEX idx_admin_commands_status ON admin_commands(status);
   ```
3. Generate API key (anon + service role keys)
4. Store in local `.env`:
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```

**Risk:** None. Schema creation is idempotent; can be re-run safely.

---

### 2. Data Migration (30 min)

**Deliverable:** All SQLite data migrated to Supabase. Record counts verified.

**Steps:**
1. Export SQLite data as JSON (bash + sqlite3 CLI):
   ```bash
   sqlite3 server/data.db \
     ".mode json" \
     "SELECT * FROM agents; SELECT * FROM messages; ..." > export.json
   ```
2. Parse JSON and import into Supabase using supabase-js:
   ```typescript
   const { data, error } = await supabase.from('agents').insert(agentsFromJson);
   ```
3. Verify record counts in Supabase match SQLite:
   ```sql
   SELECT COUNT(*) FROM agents;  -- should match local count
   ```
4. Archive SQLite database (keep as backup, don't delete)

**Risk:** Low. Data export is read-only; import can be re-run if needed. Backup kept locally.

---

### 3. Fastify Refactor (2-3 hours)

**Deliverable:** All Fastify endpoints refactored to read/write Supabase instead of SQLite.

**Changes:**
1. Install `@supabase/supabase-js`:
   ```bash
   cd server && npm install @supabase/supabase-js
   ```
2. Create `src/db.ts` wrapper (Supabase client initialization):
   ```typescript
   import { createClient } from '@supabase/supabase-js';
   export const supabase = createClient(
     process.env.SUPABASE_URL!,
     process.env.SUPABASE_ANON_KEY!
   );
   ```
3. Replace all better-sqlite3 calls with Supabase queries:
   - `db.prepare("SELECT * FROM agents").all()` → `supabase.from('agents').select()`
   - `db.prepare("INSERT INTO messages ...").run()` → `supabase.from('messages').insert(...)`
   - Update error handling (async/await instead of sync)
4. Update routes:
   - `POST /agents/register` — `supabase.from('agents').insert(...)`
   - `GET /agents` — `supabase.from('agents').select()`
   - `POST /messages` — `supabase.from('messages').insert(...)`
   - `GET /messages/:channel` — `supabase.from('messages').select().eq('channel', ...)`
   - `POST /build`, `POST /test` — insert into `builds` table with output
   - `GET /ubt/status`, `POST /ubt/acquire/release` — read/write `ubt_lock`
   - Similar for tasks, files endpoints
5. Test locally: `npm test`

**Risk:** Medium. Large refactor (many endpoints). Mitigation:
- One endpoint at a time, test after each
- Keep SQLite DB as fallback during transition (can revert)
- Run local integration tests after each change

---

### 4. Admin Command Queue & Polling Loop (1-2 hours)

**Deliverable:** Command queue + self-sufficient polling loop in Fastify.

**New Endpoints:**
1. `GET /admin/queue/next` — fetch next pending command, mark as running
   ```typescript
   const { data, error } = await supabase
     .from('admin_commands')
     .select('*')
     .eq('status', 'pending')
     .order('createdAt', { ascending: true })
     .limit(1)
     .single();

   // Update to running
   await supabase
     .from('admin_commands')
     .update({ status: 'running', startedAt: new Date() })
     .eq('id', data.id);
   ```

2. `POST /admin/queue/{id}/complete` — store command output
   ```typescript
   await supabase
     .from('admin_commands')
     .update({
       status: 'completed',
       output: result.stdout,
       stderr: result.stderr,
       completedAt: new Date()
     })
     .eq('id', id);
   ```

**Polling Loop (background task in Fastify):**
```typescript
// In src/index.ts (main server file)
setInterval(async () => {
  try {
    const command = await fetchNextPendingCommand();
    if (!command) return; // No pending commands

    const result = await executeCommand(command);
    await storeCommandResult(command.id, result);
  } catch (err) {
    console.error('Polling loop error:', err);
  }
}, 15000); // Poll every 15 seconds
```

**Command Execution:**
- Route by `type`: `git`, `docker`, `build`, `status`, `logs`
- Execute via subprocess (spawn process, capture stdout/stderr)
- Handle timeouts (kill process if exceeds max time)
- Return structured result: `{ stdout, stderr, exitCode }`

**Supported Commands:**
```
git pull origin docker/current-root
git checkout <branch>
git merge <branch>
git push origin docker/current-root
git status
docker-compose up <service>
docker-compose down <service>
python scripts/build.py <args> --verbatim
status
logs <service>
```

**Risk:** Medium. Polling loop is critical infrastructure. Mitigation:
- Add retry logic with exponential backoff (if Supabase is down)
- Log all polling events for debugging
- Monitor polling loop health (track consecutive failures)
- Graceful shutdown (drain in-flight commands before exit)

---

### 5. E2E Test (30-60 min)

**Deliverable:** Automated test verifying command queue end-to-end.

**Test Script:**
```typescript
describe('Admin Command Queue', () => {
  it('should execute a command end-to-end', async () => {
    // 1. Insert pending command
    const { data: cmd } = await supabase
      .from('admin_commands')
      .insert({ type: 'status', args: {}, status: 'pending' })
      .select()
      .single();

    // 2. Wait for polling loop to pick it up
    await new Promise(r => setTimeout(r, 500));

    // 3. Verify command was executed
    const { data: result } = await supabase
      .from('admin_commands')
      .select('*')
      .eq('id', cmd.id)
      .single();

    expect(result.status).toBe('completed');
    expect(result.output).toBeTruthy();
  });

  it('should not execute commands out of order', async () => {
    // Insert 3 commands
    // Verify they execute in FIFO order
  });
});
```

**Manual Smoke Tests:**
1. Agents can still register: `POST /agents/register` → verify in Supabase
2. Messages board works: `POST /messages` → `GET /messages/:channel`
3. Tasks queue works: claim, complete, list
4. UBT lock works: acquire, release, status
5. Dashboard can connect: no console errors

**Risk:** Low. Test is isolated and doesn't affect production.

---

## Rollback Strategy

**If migration fails or major bugs found:**

1. **Revert Fastify to SQLite:** Keep better-sqlite3 code in git history. Revert to previous commit, restore SQLite database backup.
2. **Timeline:** ~15 min to revert and restart server
3. **Data loss:** None (SQLite backup + Supabase data both exist; can sync back)
4. **Remote user impact:** Commands queued in Supabase will be lost, but no agent work is lost

**Prevention:**
- Test all endpoints locally before deployment
- Keep SQLite database during transition (don't delete)
- Run E2E test suite before leaving

---

## Success Criteria

**Before departing (TODAY):**
- ✅ Supabase project created, schema deployed, data migrated
- ✅ All Fastify endpoints refactored to Supabase (no SQLite reads)
- ✅ Polling loop operational (15s interval, FIFO execution)
- ✅ Admin command queue tested end-to-end
- ✅ Smoke tests pass (agents, messages, tasks, UBT lock still work)
- ✅ E2E test automated and passing
- ✅ Server runs stable for 30+ min without errors
- ✅ Dashboard can connect to Supabase (no auth errors)

**During remote week:**
- ✅ Remote user can insert commands into Supabase
- ✅ Fastify polls and executes commands reliably
- ✅ Output stored in Supabase, readable from remote
- ✅ No manual intervention needed on local machine
- ✅ Git/docker/build commands execute successfully
- ✅ Log output is verbatim and complete

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Supabase downtime | Low | High (remote ops blocked) | Retry logic; local cache (future); fallback to SSH |
| Command execution timeout | Medium | Medium (stuck command) | Kill process after max time; update status |
| Data corruption in migration | Very Low | High (lose state) | Backup SQLite; verify record counts; test restore |
| Polling loop bugs | Medium | Medium (missed commands) | Automated tests; logging; monitor queue depth |
| Fastify crash | Low | High (no local orchestration) | Process monitor (e.g., PM2); auto-restart |
| Race condition in FIFO execution | Low | Medium (out-of-order commands) | Use transaction locks in Supabase; test ordering |
| SQLite locks during transition | Low | Low | Archive SQLite before migration completes |

---

## Database/Server Changes Required

**New Supabase Tables:**
- `admin_commands` (new queue table)

**Existing Tables Modified:**
- All (SQLite → Supabase)

**New Fastify Endpoints:**
- `GET /admin/queue/next`
- `POST /admin/queue/{id}/complete`

**Existing Endpoints Modified:**
- All (better-sqlite3 → supabase-js)

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

| Phase | Task | Duration | Status |
|-------|------|----------|--------|
| 1 | Supabase schema + API keys | 30 min | Ready |
| 2 | Data migration | 30 min | Ready |
| 3 | Fastify refactor | 2-3 hours | Ready |
| 4 | Command queue + polling | 1-2 hours | Ready |
| 5 | E2E test + smoke test | 30-60 min | Ready |
| **Total** | | **5-6 hours** | **Go/No-go decision** |

**Realistic window:** 5-6 hours. Completion by end of day (before departure tomorrow).

---

## Notes for Review

- **Breaking change:** SQLite → Supabase is a major architectural shift. Requires testing and audit before deployment.
- **Rollback available:** Can revert to SQLite if critical bugs found (keep backup).
- **No downtime planned:** Migrate at end of development day; test overnight if needed.
- **Remote-first design:** Architecture assumes user will be away; prioritizes reliability over local convenience.
- **Future enhancements:** Rate limiting, command retries, scheduled commands, audit logging (post-launch).

