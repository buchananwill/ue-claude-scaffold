---
title: Server V3 — Parallel Worktrees and Auto-Cycling Task Pump
priority: 1
---

# Server V3 — Parallel Worktrees and Auto-Cycling Task Pump

## Context

V1–V2 of the coordination server established the single-agent model: one container, one branch, one staging worktree, one UBT lock. `launch.sh` starts a container, the agent works, pushes to the bare repo, the server syncs the staging worktree and runs builds. When the container exits, you re-run `launch.sh` manually.

V3 extends this along two axes:

1. **Auto-cycling task pump** — a container claims a task, completes it, and instead of exiting, automatically resets and claims the next pending task. The container is the pump, not the human. Since the container pushes commits one-way during its run, we can skip the `--fresh` bare repo rebuild between tasks.

2. **Parallel worktrees** — two or more containers run simultaneously, each with its own staging worktree and branch. This requires a **file-level write ownership** system: when a container claims a task that touches certain files, no other container can claim tasks that overlap those files until a reconciliation phase merges the branches and brings everyone to the same base.

### What V2 established (the foundation V3 builds on)

- **Single staging worktree**: `syncWorktree()` in `build.ts` fetches from the bare repo and hard-resets to FETCH_HEAD. One worktree, one branch at a time.
- **Task lifecycle**: pending → claimed → in_progress → completed/failed. Claim uses `X-Agent-Name` header. `sourcePath` validated against the bare repo at claim time.
- **UBT lock**: singleton mutex in `ubt_lock` table. One agent builds at a time, others queue. Stale lock swept every 60s.
- **Agent registration**: `POST /agents/register` with name + worktree (branch name). Agents deregister on exit.
- **Worker mode**: `entrypoint.sh` can poll for tasks and claim them. `WORKER_SINGLE_TASK=false` loops, but resets to `origin/<branch>` between tasks — this works for a single agent but doesn't account for parallel agents.
- **Build history**: records agent, type, start time, duration, success (output/stderr storage is a V3-dashboard concern, not covered here).

### Infrastructure (built during V3 session, before phased work began)

- **Per-agent isolation**: Each agent has its own staging worktree (`staging/<agent>/`) and bare repo (`bare-repos/<agent>.git`). No shared bare repo. Each agent's lifecycle is fully independent.
- **Staging worktree is source of truth**: The staging worktree seeds the bare repo (at launch), receives synced builds (during `/build`), and is where the user merges results. The bare repo is ephemeral — `--fresh` deletes and recreates it from the staging worktree.
- **Branch auto-detection**: `launch.sh` reads the branch from the staging worktree's current checkout. No `--branch` flag. Branch is a setup-time concern (set when creating the staging worktree), not a launch-time concern.
- **Config**: `scaffold.config.json` has `stagingWorktreeRoot` and `bareRepoRoot`. Server and launch.sh resolve per-agent paths as `<root>/<agentName>/` and `<root>/<agentName>.git`.
- **Plugin junctions**: Staging worktrees need Windows junctions for gitignored plugin repos (Voxel, UE5Coro, SubsystemBrowserPlugin). Use PowerShell `New-Item -ItemType Junction`.
- **Rider visibility**: Main worktree (`PistePerfect_5_7`) has remotes `agent-1` and `agent-2` pointing at the staging worktrees. `git fetch agent-1` shows the agent's branches.
- **entrypoint.sh**: Always pushes to bare repo at exit (not just when dirty). Shutdown trap also pushes. Build loop instructions require final build against final code — no post-build modifications.

### Implicit constraints

- **SQLite serialization**: All coordination state lives in a single SQLite DB in WAL mode. Concurrent reads are fine; writes serialize at the DB level. This is sufficient for the number of agents we're targeting (2–5 concurrent containers).
- **One UBT at a time**: Unreal Build Tool is not concurrent-safe. The UBT lock must remain a singleton. Parallel worktrees can each push code independently, but builds are serialized.
- **Per-agent bare repo as exchange**: Each container pushes to its own bare repo. The server fetches from it into the agent's staging worktree.
- **No automatic merging**: The server tracks file ownership and prevents conflicts, but does not perform git merges. The reconciliation phase is triggered by the user, who merges in the main worktree.
- **Container-side changes are minimal**: The `entrypoint.sh` multi-task loop already exists (`WORKER_SINGLE_TASK=false`). V3 server changes should make that loop more robust, not rewrite it.

### Key design principle: sticky file ownership

File ownership is **sticky until reconciliation**, not released on task completion. Here's why:

When two agents work in parallel, each pushes to its own branch. Agent-1 modifies `Foo.cpp` on `branch-1` and completes its task. If we released `Foo.cpp` at that point, agent-2 could claim a new task that also touches `Foo.cpp` — but agent-2 is working on `branch-2`, which doesn't have agent-1's changes. The result: two divergent edits to `Foo.cpp` on separate branches, which creates a merge conflict when reconciling. Even if the edits don't textually overlap, they were made against different baselines, which is noisy and error-prone.

The solution: file claims persist across task completions. They accumulate as an agent works through tasks. They are only released during an explicit **reconciliation phase**, where:
1. All agents are paused (no new claims).
2. Agent branches are merged (by the user or a merge script).
3. All containers are brought up to date on the merged result.
4. File ownership is cleared.
5. Agents resume claiming.

This means an agent that finishes early and has no more non-conflicting tasks to claim simply idles — it does not start working on files owned by other agents. This is correct behavior: it's better to idle than to create conflicts.

---

## Phase 1 — File Registry and Task-File Dependencies

Two new normalized tables model which files exist in the coordination system and which tasks will write to which files.

### Schema: new tables

**File: `server/src/db.ts`** (modify)

Bump schema version. Add:

```sql
-- Known files in the coordination system.
-- A file exists here once any task declares a dependency on it.
-- claimant is the agent that currently owns writes to this file (NULL = unowned).
-- Claims are sticky: they persist until explicit reconciliation, NOT until task completion.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  claimant   TEXT,
  claimed_at DATETIME
);

-- Join table: which tasks will write to which files.
CREATE TABLE IF NOT EXISTS task_files (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL REFERENCES files(path),
  PRIMARY KEY (task_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_task_files_path ON task_files(file_path);
```

Design notes:
- `files.path` is the relative path from the project root (e.g. `Source/MyGame/Inventory/InventoryComponent.cpp`).
- `files.claimant` is the agent name that currently owns writes. NULL means the file is available.
- `task_files` is a pure join table. A task can depend on many files; a file can be depended on by many tasks.
- `ON DELETE CASCADE` ensures that deleting a task cleans up its `task_files` rows automatically.
- The `files` table is append-only in normal operation — files are registered when tasks are created and stay in the table even after tasks complete. The `claimant` column is the only mutable field, and it's only cleared during reconciliation.

### API changes to task creation

**File: `server/src/routes/tasks.ts`** (modify)

**POST /tasks** — accept optional `files` field:

```typescript
Body: {
  title: string;
  description?: string;
  sourcePath?: string;
  acceptanceCriteria?: string;
  priority?: number;
  files?: string[];          // NEW — list of files this task will write to
}
```

When `files` is provided:
1. Validate each path: must be relative (no leading `/`, no `..` components, no empty strings). Return 400 on invalid paths.
2. For each path, `INSERT OR IGNORE INTO files (path) VALUES (?)` — register the file if not already known.
3. For each path, `INSERT INTO task_files (task_id, file_path) VALUES (?, ?)`.
4. Wrap steps 2–3 in the same transaction as the task INSERT.

**GET /tasks** and **GET /tasks/:id** — include `files` in the response:

```typescript
// After fetching the task row, join to get its files:
const taskFiles = db.prepare(
  'SELECT file_path FROM task_files WHERE task_id = ?'
).all(row.id) as { file_path: string }[];

formatTask(row) {
  // ...existing fields...
  files: taskFiles.map(f => f.file_path),  // string[] (empty array if no dependencies)
}
```

Return `[]` (not null) when a task has no file dependencies. This is unambiguous.

**PATCH /tasks/:id** — allow editing `files` on pending tasks:

- Delete existing `task_files` rows for the task, then re-insert the new set.
- Register any new file paths in the `files` table.
- Only allowed when the task is pending.

**DELETE /tasks/:id** — `ON DELETE CASCADE` handles `task_files` cleanup automatically.

### POST /tasks/batch — bulk creation

```
POST /tasks/batch
Body: { tasks: Array<{ title, description?, sourcePath?, acceptanceCriteria?, priority?, files? }> }
```

- Runs all inserts (tasks + files + task_files) in a single transaction.
- Returns `{ ok: true, ids: number[] }`.
- If any task fails validation, the entire batch is rejected (atomic).

### GET /files — file registry query

**File: `server/src/routes/files.ts`** (new)

```
GET /files
GET /files?claimant=agent-1
GET /files?unclaimed=true
```

Returns:

```json
[
  { "path": "Source/Foo.cpp", "claimant": "agent-1", "claimedAt": "2026-03-18T..." },
  { "path": "Source/Bar.h", "claimant": null, "claimedAt": null }
]
```

### Ingest script changes

**File: `scripts/ingest-tasks.sh`** (modify)

Parse a `files:` frontmatter field from task markdown files:

```markdown
---
title: Add inventory weight system
priority: 2
files:
  - Source/MyGame/Inventory/InventoryComponent.cpp
  - Source/MyGame/Inventory/InventoryComponent.h
  - Source/MyGame/UI/InventoryWidget.cpp
---
```

Pass the `files` array to `POST /tasks` (or the new batch endpoint).

### Tests

**File: `server/src/routes/tasks.test.ts`** (modify)

- POST /tasks with `files` array → task_files rows created, files registered
- POST /tasks without `files` → no task_files rows, response has `files: []`
- POST /tasks with invalid file path (`../etc/passwd`, `/absolute/path`, `""`) → 400
- GET /tasks/:id returns `files` array
- PATCH /tasks/:id can update files (old removed, new inserted)
- DELETE /tasks/:id cascades to task_files
- POST /tasks/batch creates all atomically, including file registrations
- POST /tasks/batch rolls back entirely if any single task fails validation

**File: `server/src/routes/files.test.ts`** (new)

- GET /files returns all registered files
- GET /files?claimant=X filters by claimant
- GET /files?unclaimed=true returns only unclaimed files

### Acceptance criteria

- [x] Tasks can be created with a `files` list → rows in `task_files` and `files` tables
- [x] Files are returned in GET task responses as a string array
- [x] Invalid paths are rejected with 400
- [x] Batch endpoint creates all-or-nothing
- [x] Tasks created before V3 (no file dependencies) work unchanged
- [x] GET /files returns the file registry with claimant info
- [x] `cd server && npm test` passes (73/73)

**Additional work done beyond plan:**
- [x] Unknown fields in POST/PATCH /tasks rejected with 400 (catches camelCase/snake_case mismatches)
- [x] sourcePath validation checks `project.path` (design team's branch), not staging worktrees
- [x] Ingest script parses `files:` frontmatter (code written, not yet tested)

---

## Phase 2 — File Write Ownership (Sticky Until Reconciliation)

The core coordination primitive. When an agent claims a task, the server checks whether any of that task's file dependencies are claimed by a different agent. If so, the claim is rejected. If not, those files are marked as claimed by the requesting agent. **Claims are never released by task completion** — they persist until an explicit reconciliation phase clears them.

### Claim-time ownership check

**File: `server/src/routes/tasks.ts`** (modify)

**POST /tasks/:id/claim** — extend with ownership logic:

1. Look up the task's file dependencies: `SELECT file_path FROM task_files WHERE task_id = ?`.
2. If the task has file dependencies:
   a. Check for conflicts: `SELECT path, claimant FROM files WHERE path IN (...) AND claimant IS NOT NULL AND claimant != ?` (where `?` is the claiming agent).
   b. If any conflicts exist, reject with **409 Conflict**:
      ```json
      {
        "statusCode": 409,
        "error": "Conflict",
        "message": "File ownership conflict — files are owned by another agent and cannot be claimed until reconciliation",
        "conflicts": [
          { "file": "Source/MyGame/Inventory/InventoryComponent.cpp", "claimant": "agent-1" }
        ]
      }
      ```
   c. If no conflicts, claim the files: `UPDATE files SET claimant = ?, claimed_at = CURRENT_TIMESTAMP WHERE path IN (...) AND claimant IS NULL`. (Files already claimed by this agent are left unchanged — self-overlap is fine.)
3. If the task has no file dependencies, skip ownership checks entirely.
4. The ownership update + task claim must be in the same SQLite transaction.

### What does NOT release ownership

- **POST /tasks/:id/complete** — does NOT release file ownership. The agent's branch has diverged; files stay claimed until reconciliation.
- **POST /tasks/:id/fail** — does NOT release file ownership. Even a failed task may have left partial modifications on the branch.
- **POST /tasks/:id/release** — returns a claimed task to pending. Does NOT release file ownership either, because the agent may have other completed tasks that modified those files. However, if we want to allow "unwind" semantics (agent hasn't actually started work), see the edge case below.

### Edge case: releasing a task before work begins

If an agent claims a task but hasn't started any work (status is still `claimed`, not `in_progress`), releasing it could in theory release ownership on files that no other completed task by this agent has touched. But this adds complexity for a rare case. The simpler rule is: **once claimed, files stay claimed until reconciliation**. If a task is released back to pending, it can be re-claimed by the same agent (or by any agent after reconciliation).

### Ownership cleanup on agent deregistration

**File: `server/src/routes/agents.ts`** (modify)

When `DELETE /agents/:name` is called:
- Release all files claimed by this agent: `UPDATE files SET claimant = NULL, claimed_at = NULL WHERE claimant = ?`.
- This is a safety valve. In normal flow, agents don't deregister while other agents are working — they either finish all tasks or are paused first. But if an agent crashes or is force-killed, deregistration cleans up its claims so the system doesn't deadlock.
- **Important**: this means deregistering an agent that has done real work makes its files available for other agents to claim, potentially creating merge conflicts. The dashboard and `stop.sh` should warn about this.

### Load-balancing strategy (planning for Phase 4)

The naive claim model has a starvation risk: agent-1 could claim tasks that touch files A, B, C, D early on, blocking a wide swath and starving other agents. The `/tasks/claim-next` endpoint in Phase 4 will address this with a scoring function that prefers tasks locking the fewest new files for the requesting agent. Details in Phase 4.

### Tests

**File: `server/src/routes/ownership.test.ts`** (new)

- Agent-1 claims task with files [A, B] → files A and B have claimant = agent-1
- Agent-2 tries to claim task with files [B, C] → 409 with conflict on B showing agent-1
- Agent-2 claims task with files [C, D] → succeeds, C and D claimed by agent-2
- Agent-1 completes its task → A and B **still** have claimant = agent-1 (sticky)
- Agent-2 tries to claim task with files [A] → still 409 (agent-1 owns A despite task completion)
- Task with no file dependencies → no ownership check, always claimable
- Same agent claims two tasks sharing file A → succeeds (self-overlap OK)
- Agent deregistration releases all claimed files
- After deregistration of agent-1, agent-2 can claim files [A, B]
- Releasing a claimed task back to pending does NOT release file ownership

### Acceptance criteria

- [ ] Claiming a task with file dependencies marks those files as claimed by the agent
- [ ] Overlapping claim by a different agent is rejected with 409 + conflict details
- [ ] Task completion does NOT release file ownership (sticky)
- [ ] Task failure does NOT release file ownership (sticky)
- [ ] Tasks with no file dependencies bypass ownership entirely
- [ ] Self-overlap (same agent, multiple tasks, shared files) works correctly
- [ ] Agent deregistration clears all owned files (safety valve)
- [ ] `cd server && npm test` passes

---

## Phase 3 — Parallel Staging Worktrees

Currently there is one staging worktree. The server fetches the agent's branch into it and runs the build. With parallel agents, each agent needs its own staging worktree so builds for agent-1 don't clobber agent-2's checkout.

### Config changes

**File: `server/src/config.ts`** (modify)

Add a worktree root directory option:

```typescript
server: {
  port: number;
  ubtLockTimeoutMs: number;
  stagingWorktreeRoot?: string;  // NEW — parent dir for per-agent worktrees
  stagingWorktreePath?: string;  // Existing — single worktree fallback
  bareRepoPath?: string;
}
```

- If `stagingWorktreeRoot` is set, per-agent worktrees are created at `<root>/<agentName>/`.
- If only `stagingWorktreePath` is set, fall back to single-worktree behavior (backwards-compatible).

**File: `scaffold.config.example.json`** (modify)

- Add `server.stagingWorktreeRoot` example.

### Worktree resolution

**File: `server/src/routes/build.ts`** (modify)

Replace `getStagingWorktree()` with `getOrCreateStagingWorktree(agentName)`:

```typescript
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function getOrCreateStagingWorktree(agentName: string | undefined): string {
  const root = config.server.stagingWorktreeRoot;
  if (!root || !agentName) {
    return config.server.stagingWorktreePath ?? config.project.path;
  }

  const worktreePath = path.join(root, agentName);
  if (!existsSync(worktreePath)) {
    const bareRepo = getBareRepoPath();
    const agentRow = db.prepare('SELECT worktree FROM agents WHERE name = ?')
      .get(agentName) as { worktree: string } | undefined;
    const branch = agentRow?.worktree ?? 'main';

    execFileSync('git', ['clone', bareRepo, worktreePath, '--branch', branch], {
      timeout: 60000,
    });
  }
  return worktreePath;
}
```

`syncWorktree()` still does `git fetch` + `git reset --hard FETCH_HEAD` — now in the agent-specific worktree. Each agent's worktree fetches and resets to its own branch.

The UBT lock still serializes actual builds. Two agents can prepare their worktrees concurrently, but only one runs UBT at a time.

### Worktree cleanup

**File: `server/src/routes/agents.ts`** (modify)

On agent deregistration (`DELETE /agents/:name`):

- Add optional query param: `DELETE /agents/:name?cleanup=true`.
- If `cleanup=true` and `stagingWorktreeRoot` is configured, remove the directory at `<root>/<agentName>/`.
- Default: leave the worktree in place (users may want to inspect it after the run).

### Tests

**File: `server/src/routes/build.test.ts`** (modify)

- Two agents get different staging worktree paths when `stagingWorktreeRoot` is set
- Single-agent fallback works when only `stagingWorktreePath` is set
- Worktree is created on first build for a new agent

### Acceptance criteria

- [ ] Each agent gets its own staging worktree under `stagingWorktreeRoot/`
- [ ] Builds use the correct per-agent worktree as cwd
- [ ] UBT lock still serializes builds (one at a time)
- [x] Backwards-compatible: single `stagingWorktreePath` still works
- [ ] `cd server && npm test` passes (tests not yet written for Phase 3)

**Status:** Config, launch.sh, and server path resolution are done (see Infrastructure section above). The server resolves per-agent worktree and bare repo paths. What remains is writing the Phase 3 tests.

---

## Phase 4 — Auto-Cycling Task Pump

The container becomes a long-running pump that automatically claims the next task after completing the current one. The server provides a `claim-next` endpoint that respects file ownership and load-balances to minimize contention.

### Server: claim-next endpoint

**File: `server/src/routes/tasks.ts`** (modify)

**POST /tasks/claim-next** — atomically find and claim the next eligible task:

```
POST /tasks/claim-next
Headers: X-Agent-Name: <name>
Body: { }
```

Logic (single SQLite transaction):
1. Get the claiming agent's name from the header.
2. Find eligible pending tasks. A task is eligible if:
   - Status is `pending`.
   - It has no file dependencies (no `task_files` rows), OR
   - None of its file dependencies are claimed by a different agent.
3. Among eligible tasks, **load-balance** by preferring tasks that lock the fewest new files for this agent. This minimizes the agent's "blast radius" and leaves more files available for other agents.
4. Break ties by priority (higher first), then by id (lower first = older tasks first).
5. Claim the winning task: set status to `claimed`, `claimed_by`, `claimed_at`.
6. Mark its files as claimed by this agent (where not already claimed by this agent).
7. Return the full formatted task.

### Load-balanced scoring query

```sql
-- Find the best eligible pending task for agent ?1.
-- Eligible: no file deps, or all file deps are either unclaimed or claimed by ?1.
-- Score: number of NEW file locks this claim would create (lower = better).
-- Ties: higher priority wins, then lower id (older task) wins.
SELECT t.id,
  COUNT(CASE WHEN f.claimant IS NULL THEN 1 END) as new_locks
FROM tasks t
LEFT JOIN task_files tf ON tf.task_id = t.id
LEFT JOIN files f ON f.path = tf.file_path
WHERE t.status = 'pending'
  AND NOT EXISTS (
    -- Exclude tasks where ANY file is claimed by a DIFFERENT agent
    SELECT 1 FROM task_files tf2
    JOIN files f2 ON f2.path = tf2.file_path
    WHERE tf2.task_id = t.id
      AND f2.claimant IS NOT NULL
      AND f2.claimant != ?1
  )
GROUP BY t.id
ORDER BY new_locks ASC, t.priority DESC, t.id ASC
LIMIT 1
```

Tasks with no file dependencies have `new_locks = 0` and sort first (tied with other zero-lock tasks, broken by priority). This naturally prefers unconstrained tasks, which is desirable — it lets ownership-free tasks run while the contested ones wait.

### Response shapes

Task found:
```json
{
  "task": {
    "id": 5,
    "title": "...",
    "description": "...",
    "files": ["Source/Foo.cpp", "Source/Foo.h"],
    "acceptanceCriteria": "...",
    ...
  }
}
```

No eligible task:
```json
{
  "task": null,
  "pending": 3,
  "blocked": 3,
  "reason": "all pending tasks have file conflicts"
}
```

No tasks at all:
```json
{
  "task": null,
  "pending": 0,
  "blocked": 0
}
```

This is always a 200 — the pump interprets the response and decides whether to poll again or exit.

### Agent mode tracking

**File: `server/src/db.ts`** (modify)

```sql
ALTER TABLE agents ADD COLUMN mode TEXT DEFAULT 'single';
```

Values: `'single'` (one task then exit), `'pump'` (auto-cycle through tasks).

**File: `server/src/routes/agents.ts`** (modify)

**POST /agents/register** — accept optional `mode` field:

```typescript
Body: { name: string; worktree: string; planDoc?: string; mode?: 'single' | 'pump' }
```

**GET /agents/:name** — new endpoint (needed for pump status checks):

```typescript
fastify.get<{ Params: { name: string } }>('/agents/:name', async (request, reply) => {
  const row = getAgent.get({ name: request.params.name }) as AgentRow | undefined;
  if (!row) return reply.notFound(`Agent '${request.params.name}' not registered`);
  return formatAgent(row);
});
```

Include `mode` in `formatAgent()`.

### Container changes

**File: `container/entrypoint.sh`** (modify)

Replace the `poll_and_claim_task()` function to use `/tasks/claim-next`:

```bash
poll_and_claim_task() {
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        attempt=$((attempt + 1))

        CLAIM_RESPONSE=$(curl -s -X POST "${SERVER_URL}/tasks/claim-next" \
            -H "X-Agent-Name: ${AGENT_NAME}" \
            -H "Content-Type: application/json" \
            -d '{}' \
            --max-time 10) || CLAIM_RESPONSE='{"task":null,"pending":0}'

        TASK=$(echo "$CLAIM_RESPONSE" | jq '.task // empty')
        if [ -n "$TASK" ] && [ "$TASK" != "null" ]; then
            CURRENT_TASK_ID=$(echo "$TASK" | jq -r '.id')
            CURRENT_TASK_TITLE=$(echo "$TASK" | jq -r '.title // "Untitled"')
            CURRENT_TASK_DESC=$(echo "$TASK" | jq -r '.description // ""')
            CURRENT_TASK_AC=$(echo "$TASK" | jq -r '.acceptanceCriteria // "None specified"')
            echo "Claimed task #${CURRENT_TASK_ID}: ${CURRENT_TASK_TITLE}"
            return 0
        fi

        # No task claimed — check why
        local pending=$(echo "$CLAIM_RESPONSE" | jq -r '.pending // 0')
        if [ "$pending" = "0" ]; then
            echo "No pending tasks remain. Pump complete."
            return 1
        fi

        # Tasks exist but are blocked by file ownership — wait for reconciliation
        _post_status "idle"
        echo "No claimable tasks (${pending} pending, blocked by file ownership). Waiting ${WORKER_POLL_INTERVAL}s... (${attempt}/${max_attempts})"
        sleep "$WORKER_POLL_INTERVAL"
    done

    echo "ERROR: No claimable tasks after ${max_attempts} attempts"
    _post_status "error"
    return 1
}
```

Between tasks in the pump loop:
1. Final push of uncommitted work (existing).
2. Report task completion/failure (existing). File ownership is NOT released.
3. `git fetch origin && git reset --hard origin/${WORK_BRANCH}` — sync to latest from the agent's own branch. Picks up its own previous commits without `--fresh`.
4. Check agent status before claiming next:

```bash
AGENT_STATUS=$(curl -sf "${SERVER_URL}/agents/${AGENT_NAME}" | jq -r '.status // "unknown"') || AGENT_STATUS="unknown"
if [ "$AGENT_STATUS" = "paused" ]; then
    echo "Agent paused (reconciliation in progress?). Waiting..."
    sleep "$WORKER_POLL_INTERVAL"
    continue
fi
```

### launch.sh changes

**File: `launch.sh`** (modify)

- Add `--pump` convenience flag: `--pump` ≡ `--worker` with `WORKER_SINGLE_TASK=false`.
- When `--pump` is used, register agent with `mode: 'pump'`.

### Tests

**File: `server/src/routes/tasks.test.ts`** (modify)

- POST /tasks/claim-next returns highest-priority eligible task
- POST /tasks/claim-next skips tasks with file conflicts against other agents
- POST /tasks/claim-next allows tasks with files already owned by the claiming agent
- POST /tasks/claim-next returns `{ task: null, pending: 0 }` when empty
- POST /tasks/claim-next returns `{ task: null, pending: N, blocked: N }` when all blocked
- POST /tasks/claim-next acquires file ownership atomically with the claim
- Two agents calling claim-next concurrently don't get the same task
- Load balancing: given two eligible tasks, agent gets the one locking fewer new files
- GET /agents/:name returns agent details including mode

### Acceptance criteria

- [ ] `/tasks/claim-next` atomically finds and claims the best eligible task
- [ ] File ownership conflicts are respected — agent gets the next non-conflicting task
- [ ] Load balancing prefers tasks with minimal new file locks
- [ ] Container pump mode cycles through tasks without manual intervention
- [ ] No `--fresh` needed between pump cycles
- [ ] Agent registers with `mode: 'pump'` in pump mode
- [ ] Pump exits gracefully when no pending tasks remain
- [ ] Pump idles correctly when tasks exist but are all blocked by file ownership
- [ ] `cd server && npm test` passes

---

## Phase 5 — Reconciliation and Parallel Launch Orchestration

This phase adds the reconciliation lifecycle that releases file ownership, and wires up multi-agent launching.

### Reconciliation lifecycle

The reconciliation phase is the mechanism that releases sticky file ownership. The server provides lifecycle control; the actual git merges are performed externally (by the user or a script).

**File: `server/src/routes/coalesce.ts`** (new)

#### GET /coalesce/status — readiness check

```json
{
  "canCoalesce": false,
  "reason": "2 tasks still in progress",
  "agents": [
    {
      "name": "agent-1", "status": "working", "mode": "pump",
      "branch": "feature/big-refactor-1",
      "ownedFiles": ["Source/Foo.cpp", "Source/Foo.h"],
      "activeTasks": 1
    },
    {
      "name": "agent-2", "status": "idle", "mode": "pump",
      "branch": "feature/big-refactor-2",
      "ownedFiles": ["Source/Bar.cpp"],
      "activeTasks": 0
    }
  ],
  "pendingTasks": 3,
  "totalClaimedFiles": 3
}
```

`canCoalesce: true` when:
- No tasks are in `claimed` or `in_progress` status.
- All pump agents are either `idle`, `done`, or `paused`.

This does NOT require `pendingTasks == 0` — there may be tasks still queued that are blocked on file ownership. Reconciliation is specifically to clear those blocks.

#### POST /coalesce/pause — prepare for reconciliation

1. Sets all pump-mode agents to `status: 'paused'`.
2. Returns the list of paused agents and their in-flight tasks.
3. Containers check their status before claiming the next task. If paused, they sleep and retry. In-flight tasks are allowed to finish naturally.

```json
{
  "paused": ["agent-1", "agent-2"],
  "inFlightTasks": [
    { "agent": "agent-1", "taskId": 7, "title": "Refactor movement component" }
  ]
}
```

The user waits for in-flight tasks to complete (polling `/coalesce/status` until `canCoalesce: true`), then performs the merge.

#### POST /coalesce/release — clear file ownership and resume

Called after branches have been merged:

1. Clears all file ownership: `UPDATE files SET claimant = NULL, claimed_at = NULL`.
2. Sets all paused agents to `status: 'idle'`.
3. Returns the count of released files and resumed agents.

```json
{
  "releasedFiles": 5,
  "resumedAgents": ["agent-1", "agent-2"]
}
```

After this, containers detect they're no longer paused and resume calling `/tasks/claim-next`. They'll pick up the merged code via `git fetch && git reset --hard` at the start of their next task cycle.

#### POST /coalesce/release with branch update

In practice, after merging agent branches into a shared base, each agent container needs to be on a fresh branch forked from the merged result. The `/coalesce/release` endpoint can optionally accept a `baseBranch` parameter:

```
POST /coalesce/release
Body: { baseBranch?: string }
```

If `baseBranch` is provided, the server updates each agent's registered `worktree` (branch) to a new branch forked from the base. The container's next `git fetch && git reset --hard` will pick up the merged code.

This is a stretch goal — the simpler version just clears ownership and the user manually manages branches.

### Parallel launch

**File: `launch.sh`** (modify)

Add `--parallel N` flag:

```bash
./launch.sh --pump --parallel 3
```

This launches N containers (agent-1 through agent-N), each on its own branch:
- `agent-1` → `feature/<plan-name>-1`
- `agent-2` → `feature/<plan-name>-2`
- `agent-3` → `feature/<plan-name>-3`

`--parallel` implies `--pump`.

Implementation:
```bash
if [ "$PARALLEL_COUNT" -gt 1 ]; then
    BASE_BRANCH="$WORK_BRANCH"
    git -C "$CLONE_SOURCE" push "$BARE_REPO_PATH" "HEAD:refs/heads/${BASE_BRANCH}" --force

    for i in $(seq 1 "$PARALLEL_COUNT"); do
        _AGENT="agent-${i}"
        _BRANCH="${BASE_BRANCH}-${i}"

        # Fork branch from base in bare repo
        git -C "$BARE_REPO_PATH" branch "$_BRANCH" "$BASE_BRANCH" 2>/dev/null || \
          git -C "$BARE_REPO_PATH" branch -f "$_BRANCH" "$BASE_BRANCH"

        AGENT_NAME="$_AGENT" WORK_BRANCH="$_BRANCH" \
          WORKER_MODE=true WORKER_SINGLE_TASK=false \
          $COMPOSE_CMD --project-name "claude-${_AGENT}" up --build --detach
    done

    echo "Launched $PARALLEL_COUNT parallel agents in pump mode."
    echo "Branches: ${BASE_BRANCH}-1 through ${BASE_BRANCH}-${PARALLEL_COUNT}"
fi
```

### stop.sh

**File: `stop.sh`** (new)

```bash
./stop.sh                    # Stop all claude-* containers immediately
./stop.sh --agent agent-2    # Stop a specific agent
./stop.sh --drain            # Pause all agents, wait for in-flight tasks, then stop
```

`--drain` flow:
1. `POST /coalesce/pause`
2. Poll `GET /coalesce/status` until `canCoalesce: true` (or timeout, default 10 min)
3. Stop all `claude-*` containers
4. Print summary: branches to merge, files that were owned, remaining pending tasks

Note: `--drain` does NOT call `/coalesce/release` — that's the user's responsibility after merging. This is intentional: stopping containers + clearing ownership without merging first would lose the safety guarantee.

### Tests

**File: `server/src/routes/coalesce.test.ts`** (new)

- GET /coalesce/status reports `canCoalesce: true` when all agents idle and no active tasks
- GET /coalesce/status reports `canCoalesce: false` with reason when tasks in progress
- POST /coalesce/pause sets all pump agents to paused
- POST /coalesce/release clears all file ownership and resumes agents
- After release, previously blocked tasks become claimable
- Paused agent status is reflected in GET /agents/:name

### Acceptance criteria

- [ ] `./launch.sh --pump --parallel 3` starts 3 containers on separate branches
- [ ] Each container gets its own staging worktree (Phase 3)
- [ ] File ownership prevents two agents from claiming overlapping tasks
- [ ] File ownership persists through task completions (sticky)
- [ ] GET /coalesce/status reports whether reconciliation can proceed
- [ ] POST /coalesce/pause pauses all pump agents; in-flight tasks finish naturally
- [ ] POST /coalesce/release clears all ownership and resumes agents
- [ ] `stop.sh --drain` gracefully drains and stops all agents
- [ ] After reconciliation, previously blocked tasks become available
- [ ] `cd server && npm test` passes

---

## Phase ordering and dependencies

```
Phase 1 (File Registry)         — independent, start immediately
Phase 2 (Write Ownership)       — depends on Phase 1 (needs files + task_files tables)
Phase 3 (Parallel Worktrees)    — independent, start immediately
Phase 4 (Task Pump)             — depends on Phase 2 (claim-next respects ownership)
Phase 5 (Reconciliation+Launch) — depends on Phases 2, 3, and 4
```

```
Phase 1 ──→ Phase 2 ──→ Phase 4 ──┐
                                    ├──→ Phase 5
Phase 3 ───────────────────────────┘
```

Phases 1 and 3 are parallelizable. The critical path is **1 → 2 → 4 → 5**.

Recommended execution order for a single implementer: **1 → 3 → 2 → 4 → 5**

- Phase 1 first: small schema + API change, foundation for everything.
- Phase 3 next: independent of ownership, low risk, needed for Phase 5.
- Phase 2: core coordination. Requires Phase 1.
- Phase 4: pump + claim-next + load balancing. Requires Phase 2.
- Phase 5: reconciliation lifecycle + parallel launch. Ties everything together.

## Verification (full V3)

1. `cd server && npm test` — all tests pass.
2. **Single-agent regression**: `launch.sh --worker` still works identically to V2. No file ownership created (tasks have no `files` field). No reconciliation needed.
3. **Single-agent pump**: Create 5 tasks with no file dependencies. Launch with `--pump`. Agent claims all 5 sequentially, exits when done.
4. **Parallel with no conflicts**: Create 6 tasks, each touching unique files (no overlap). Launch with `--parallel 2`. Both agents work through tasks concurrently. All complete without blocking.
5. **Parallel with conflicts**: Create 6 tasks where tasks #3 and #5 share a file. Launch with `--parallel 2`. Both agents claim non-conflicting tasks first. When one agent tries to claim #5, it's blocked because agent-1 owns the shared file from #3. The blocked agent picks a different task or idles.
6. **Reconciliation**: After both agents idle, `POST /coalesce/pause` → merge branches externally → `POST /coalesce/release` → agents resume and claim previously-blocked tasks.
7. **Load balancing**: With 3 agents and tasks of varying file scope, verify that agents don't hog more files than necessary (prefer tasks locking fewer new files).
8. **Pump endurance**: Pump mode cycles 10+ tasks without manual intervention or `--fresh`.
9. **Drain**: `stop.sh --drain` pauses agents, waits for in-flight tasks, then stops cleanly. File ownership is preserved (not released) until the user explicitly reconciles.
10. GET /files shows file ownership map with claimants at all times.
