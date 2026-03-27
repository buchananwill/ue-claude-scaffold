# Milestone: Remote Operations & Dashboard Consolidation

**Timeline:** TODAY (2026-03-27) — plan + COMPLETE implementation + E2E test. Tomorrow (2026-03-28) — depart, remote week starts (2026-03-31–2026-04-06).

---

## Session Summary: Pain Points → Architecture

### Dashboard UI Pain Points (Quick Wins)

**1. Chat Rooms Lack Deep Linking**
- Chat room buttons are not semantic links (no unique URL per chat)
- Cannot open chat in new tab, share link, or bookmark specific conversation
- No browser history support for navigation between chats

**2. Message Visual Separation Unclear**
- Messages blur together in current styling
- Need individual message containers (mini-cards with borders/backgrounds)
- Adopt WhatsApp-like demarcation — each message visually distinct with clear sender attribution

**3. Scroll Behavior Disrupts Reading**
- View jumps when new messages arrive
- User loses reading position when scrolling back through history
- Auto-scroll to latest message breaks manual browsing flow

### Dashboard Architecture Pain Points (Consolidation Phase)

**4. Dashboard Needs Structural Consolidation**

*Navigation & Layout:*
- Consolidate overview/messages/logs/chat/teams into a collapsible sidebar
- Chat room list should collapse to maximize conversation viewport

*Content Rendering:*
- Messages page lacks formatting — agents deliver markdown that renders as raw text
- Need markdown rendering by default with optional toggle for edge cases

*Message Protocol Standardization:*
- Message payloads lack consistent key structure: sometimes `"message"`, sometimes `"summary"`, sometimes `"notes"`
- Database stores flexible text payloads (acceptable for flexibility)
- **Problem:** Agents are improvising key names with no discipline
- **Solution:** Standardize message protocol — agents must follow strict structure

*URL State Management (Core Philosophy Shift):*
- All UI-controlled REST parameters must encode in URL/search params
- Currently some state lives only in client state (invisible)
- Dashboard philosophy: **transparent presentation of server REST endpoints**
- If UI modifies a request, it must show in the URL so remote users can see what's being queried

**5. Migration: Local SQLite → Supabase (Remote Operations)**

*Motivation:*
- User departing for one week, needs remote coordination capability
- Local system stays running as build host + container orchestrator
- Supabase becomes cloud-hosted source of truth for ALL coordination data

*Architecture Shift:*
- **SQLite (deprecated)** → **Supabase (cloud)** — wholesale replacement, new source of truth for:
  - Agents (registration, status, metadata)
  - Messages (message board, channels, history)
  - Builds (build history, logs, status)
  - Tasks (task queue, state, claim/release)
  - UBT lock (mutex state, priority queue)
  - Files (ownership registry)
  - Admin commands (new queue for remote operations)
  - All other coordination state

- **Local Fastify server** (localhost:9100) = gateway/intermediary
  - Reads/writes all coordination data to Supabase (replaces SQLite)
  - Polls Supabase for admin commands (every 15s)
  - Executes commands locally (Docker, UBT, git)
  - Transmits command output back to Supabase
  - Handles UBT mutex and build orchestration
  - Acts as security boundary — only expose specific operations, not arbitrary access

*Data Flow:*
```
Remote Client → Supabase (admin commands table)
                    ↓
              Local Fastify Server (polls, executes, logs)
                    ↓
              Supabase (command output + state)
                    ↓
              Remote Client (reads results)
```

*Authentication:*
- API key (stored in local `.env`)
- No OAuth (not resilient to user absence)
- Credentials are static — survive Supabase restart/failover

*Polling Model:*
- Frequency: 15 seconds (responsive without thrashing)
- Execution: FIFO queue, chronological serialization (one command at a time, no parallelism)
- Philosophy: "Expose a controlled subset of how I interact with my terminal here"

---

## Remote Admin Command Set

**Exposed via Supabase admin queue. Fastify executes, captures output, transmits back to Supabase.**

### Git Operations
```
git pull origin docker/current-root     # Sync plan updates from remote
git checkout <branch>                   # Switch to agent branch
git merge <branch>                      # Merge agent work into local root
git push origin docker/current-root     # Safety push (bare repo state → Github)
git status                              # View current state
```

### Container Control
```
docker-compose up <service>             # Spin up container (server, dashboard, etc.)
docker-compose down <service>           # Tear down container
```

### Build & Verification
```
python scripts/build.py <args> --verbatim   # Launch UBT, return unparsed output
```
(Flag `--verbatim` added to Python script to suppress parsing, return raw stdout/stderr to Supabase)

### Debug & Status
```
status                                  # Health check + running containers list
logs <service>                          # Tail container logs to Supabase
```

---

## Implementation Plan — TODAY (One-Day Crunch)

**SCOPE:** Get Supabase coordination server + remote command queue fully operational and E2E tested.

**DEFER:** Dashboard UI consolidation, message protocol standardization. These are improvements, not blockers for remote ops.

### Execution Order

**1. Supabase Setup (30 min)**
- Create Supabase project
- Define schema (SQL):
  ```sql
  CREATE TABLE agents (id UUID PRIMARY KEY, name TEXT UNIQUE, status TEXT, metadata JSONB, createdAt TIMESTAMP, lastHeartbeat TIMESTAMP);
  CREATE TABLE messages (id UUID PRIMARY KEY, channel TEXT, author TEXT, content TEXT, metadata JSONB, createdAt TIMESTAMP);
  CREATE TABLE builds (id UUID PRIMARY KEY, target TEXT, config TEXT, status TEXT, output TEXT, stderr TEXT, exitCode INT, createdAt TIMESTAMP);
  CREATE TABLE tasks (id UUID PRIMARY KEY, status TEXT, owner TEXT, plan TEXT, args JSONB, createdAt TIMESTAMP, claimedAt TIMESTAMP, completedAt TIMESTAMP);
  CREATE TABLE ubt_lock (lockHolder TEXT PRIMARY KEY, priority INT, acquiredAt TIMESTAMP, ttl INT);
  CREATE TABLE files (path TEXT PRIMARY KEY, owner TEXT, createdAt TIMESTAMP, modifiedAt TIMESTAMP);
  CREATE TABLE admin_commands (id UUID PRIMARY KEY, type TEXT, args JSONB, status TEXT, output TEXT, stderr TEXT, createdAt TIMESTAMP, startedAt TIMESTAMP, completedAt TIMESTAMP);
  ```
- Enable Row Level Security (optional, depends on auth strategy)
- Generate Supabase API key
- Store in local `.env` (`SUPABASE_URL`, `SUPABASE_KEY`)

**2. Data Migration (30 min)**
- Export SQLite data as JSON (bash + sqlite3 CLI)
- Import JSON → Supabase (script using supabase-js)
- Verify record counts match

**3. Fastify Refactor (2-3 hours)**
- Install `@supabase/supabase-js` in `server/`
- Create `src/db.ts` wrapper (Supabase client initialization)
- Replace all `db.prepare()` calls with Supabase queries
- Update endpoints:
  - `POST /agents/register`, `GET /agents`, etc. → Supabase
  - `POST /messages`, `GET /messages` → Supabase
  - `GET /builds`, `POST /build` → Supabase (store output)
  - `GET /tasks`, `POST /tasks/claim`, etc. → Supabase
  - UBT lock: `GET /ubt/status`, `POST /ubt/acquire/release` → Supabase
- Test locally (run `npm test`)

**4. Admin Command Queue (1-2 hours)**
- New endpoint: `GET /admin/queue/next`
  - Polls Supabase admin_commands table for status='pending'
  - Returns first one, marks as 'running'
  - Returns command details (type, args)
- New endpoint: `POST /admin/queue/{id}/complete`
  - Updates Supabase with output, stderr, status='completed'
- Polling loop integration (if Fastify needs to poll internally, or dashboard polls instead)
- Command executor (already exists in Python/shell, just wire up via endpoints)

**5. E2E Test (30 min - 1 hour)**
- Create simple test:
  1. Insert a pending command into Supabase (`admin_commands` table)
  2. Call `GET /admin/queue/next` → verify it returns the command
  3. Execute command locally (git status, etc.)
  4. Call `POST /admin/queue/{id}/complete` with output
  5. Query Supabase to verify output is stored
- Verify agents can still register/report status
- Verify messages board works
- Smoke test dashboard (can it connect?)

**DEFER:**
- Dashboard UI improvements (sidebar, deep links, scroll fixes, markdown rendering) — do post-trip
- Message protocol standardization — do post-trip
- Advanced polling/retry logic — start simple, iterate remotely if needed

---

## Remote Workflow

1. **Planning** (remote Claude session)
   - Iterate on design/architecture
   - Commit plan docs

2. **Sync** (via admin queue)
   - `git pull origin docker/current-root` — fetch latest plan
   - `git status` — view state

3. **Launch Agents** (via container control commands, but NOT yet exposed in Phase 1)
   - Will be added in Phase 2 or later if needed
   - For now: manual launch from dashboard (no remote trigger needed)

4. **Monitor & Build** (via admin queue)
   - `git merge docker/<agent-name>` — integrate agent work
   - `python scripts/build.py <args> --verbatim` — verify build
   - `git status` — check state

5. **Safety Push** (via admin queue)
   - `git push origin docker/current-root` — push to Github
   - Read output remotely to diagnose any merge conflicts or build failures

6. **Design Loop** (remote review)
   - Pull Github updates remotely
   - Begin next planning cycle

---

## Critical Implementation Notes

### Supabase Schema Design
- Admin commands table must support JSON `args` field (flexible command parameters)
- Consider separate logs table or store all in one (command + output together is cleaner)
- Include `createdAt`, `startedAt`, `completedAt` for observability
- Soft-delete or archive old commands (retention policy TBD)

### Fastify Polling Loop
- Poll `GET /admin/queue/next` — fetch one pending command
- Execute synchronously (no parallelism, FIFO discipline)
- Capture stdout/stderr; handle timeouts gracefully
- Update Supabase with results via `POST /admin/queue/{id}/complete`
- Retry failed commands with exponential backoff (optional, depends on criticality)

### Security Boundary
- Only expose commands in the explicit allow-list (git, docker-compose, python build.py, status, logs)
- Validate all args before passing to subprocess (whitelist branch names, service names, etc.)
- Log all command executions to Supabase for audit trail
- No shell escape characters in args; use parameterized execution

### Dashboard Remote Access
- Assume dashboard runs locally (not exposed to internet yet)
- Remote client accesses Supabase directly for state/logs (no proxy through Fastify)
- Fastify exposes only local `/health` and polling endpoints
- Future: if dashboard goes remote, add reverse proxy or auth gateway

---

## Success Criteria — TODAY

- ✅ Supabase project created + schema deployed
- ✅ SQLite data migrated → Supabase (verified record counts)
- ✅ Fastify server talking to Supabase (all endpoints refactored)
- ✅ Admin command queue polling + execution working end-to-end
- ✅ Remote client can insert commands into Supabase, Fastify executes, output stored + readable
- ✅ E2E test passes (command → execution → result storage → retrieval)
- ✅ Agents can still register, tasks work, messages board functional
- ✅ System is stable enough to leave running 24/7 during remote week

## Post-Trip Improvements (Remote Week)

- Collapsible sidebar + chat deep linking
- Message card styling + scroll fixes
- URL-driven state management
- Message markdown rendering
- Message protocol standardization

---

## Blocking Questions (Must Resolve Today)

1. **Supabase project:** Do you have a Supabase account, or should we create one? (Free tier is fine for dev.)
2. **Data migration:** How many existing records are in SQLite? (agents, messages, builds, tasks) Do we need a full migration, or can we start fresh?
3. **Command polling:** Should the polling loop run inside Fastify (background task), or should the dashboard/remote client trigger it?

## Non-Blocking / Later

- Supabase connection resilience (retry + local caching)
- Command timeout/cancellation
- Logs retention policy
- Dashboard remote access (VPN vs. Vercel deployment)
- Agent container launch via admin queue

