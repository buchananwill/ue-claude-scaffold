# Plan: Branch-Aware Task Lifecycle and Dependency Graph Replan

Consolidates issues #012 and #017. Addresses two related gaps: tasks completed on one agent's branch are invisible to other agents, and the dependency graph lacks cycle detection and priority recomputation.

---

## Phase 1: Schema — `integrated` status and schema version bump

**Files:**
- `server/src/db.ts`

**Work:**
1. Add `'integrated'` to the tasks status CHECK constraint: `('pending','claimed','in_progress','completed','failed','integrated','cycle')`.
2. Add `'cycle'` to the same CHECK constraint (needed by Phase 4).
3. Bump schema version from 7 to 8.
4. Add migration block: `ALTER TABLE tasks ... CHECK ...` — SQLite doesn't support altering CHECK constraints, so use the existing try/catch migration pattern to recreate if needed, or handle via a pragma-based approach. Alternatively, since the CHECK is only enforced on INSERT/UPDATE, add a v7→v8 migration that is a no-op if already at v8 (the new schema SQL handles new databases; existing databases need the constraint relaxed). Document the approach.

**Acceptance criteria:**
- New databases get the full status set in the CHECK constraint.
- Existing databases accept `integrated` and `cycle` as valid status values.
- `INSERT INTO tasks (title, status) VALUES ('x', 'integrated')` succeeds.
- `INSERT INTO tasks (title, status) VALUES ('x', 'cycle')` succeeds.
- `INSERT INTO tasks (title, status) VALUES ('x', 'invalid')` fails.

---

## Phase 2: `integrated` status endpoints and migration of existing data

**Files:**
- `server/src/routes/tasks.ts`
- `server/src/routes/tasks.test.ts`

**Work:**
1. `POST /tasks/:id/integrate` — moves a single task from `completed` to `integrated`. Returns 400 if task is not `completed`.
2. `POST /tasks/integrate-batch` — accepts `{"agent": "agent-1"}` body. Moves all tasks with `status = 'completed'` and `result` containing `"agent": "agent-1"` to `integrated`. Returns the count and list of integrated task IDs.
3. `POST /tasks/integrate-all` — moves all `completed` tasks to `integrated` regardless of agent. For use after merging all branches into `docker/current-root`.
4. Update `GET /tasks` and `GET /tasks/:id` to return the new status values.
5. Update `formatTask` to include the completing agent in a top-level `completedBy` field (extracted from `result.agent`) for dashboard convenience.

**Acceptance criteria:**
- `POST /tasks/1/integrate` on a completed task returns 200 and task has `status = 'integrated'`.
- `POST /tasks/1/integrate` on a pending task returns 400.
- `POST /tasks/integrate-batch` with `{"agent": "agent-1"}` integrates only agent-1's completed tasks.
- `POST /tasks/integrate-all` integrates all completed tasks.
- `GET /tasks` returns tasks with `integrated` status correctly.

---

## Phase 3: Branch-aware dependency resolution in `claim-next`

**Files:**
- `server/src/routes/tasks.ts`
- `server/src/routes/tasks.test.ts`

**Work:**
1. Rewrite the dependency check in `claimNextCandidate` SQL. Current logic:
   ```sql
   AND NOT EXISTS (
     SELECT 1 FROM task_dependencies d
     JOIN tasks dep ON dep.id = d.depends_on
     WHERE d.task_id = t.id AND dep.status != 'completed'
   )
   ```
   New logic — a dependency is met if:
   - `dep.status = 'integrated'` (available to all agents), OR
   - `dep.status = 'completed'` AND `dep.result` contains the same agent name as the requesting agent (work is on this agent's branch)

   A dependency is **not** met if:
   - `dep.status = 'completed'` by a **different** agent (work exists but not on this branch)
   - `dep.status` is anything else (`pending`, `in_progress`, `failed`, `cycle`)

2. Update the `countDepBlocked` query to match the new logic.
3. Update `POST /tasks/:id/claim` validation to use the same branch-aware check.
4. Update the `blockReasons` array in `formatTask` responses to distinguish "blocked by incomplete task" from "blocked by work on another branch".

**Acceptance criteria:**
- Agent-2 cannot claim a task whose dependency was completed by agent-1 (not integrated).
- Agent-1 can claim a task whose dependency was completed by agent-1.
- Any agent can claim a task whose dependency is `integrated`.
- Mixed case: task depends on two things — one `integrated`, one `completed` by the requesting agent — claimable.
- Mixed case: task depends on two things — one `integrated`, one `completed` by a different agent — not claimable.
- `blockedBy` response includes the reason type (branch vs incomplete).

---

## Phase 4: Dependency-preferential claiming

**Files:**
- `server/src/routes/tasks.ts`
- `server/src/routes/tasks.test.ts`

**Work:**
1. Add a claiming preference tier to the `claimNextCandidate` ORDER BY. Current order: `new_locks ASC, priority DESC, id ASC`. New order:

   ```sql
   ORDER BY
     -- Tier 1: tasks whose deps were completed by this agent (chain continuation)
     CASE WHEN EXISTS (
       SELECT 1 FROM task_dependencies d
       JOIN tasks dep ON dep.id = d.depends_on
       WHERE d.task_id = t.id
         AND dep.status = 'completed'
         AND json_extract(dep.result, '$.agent') = ?
     ) THEN 0
     -- Tier 2: tasks with all deps integrated or no deps
     ELSE 1 END ASC,
     new_locks ASC,
     t.priority DESC,
     t.id ASC
   ```

2. The agent parameter needs to be bound twice in the query (once for file ownership check, once for preference tier).

**Acceptance criteria:**
- Agent-1 completes task A. Task B depends on A. Task C is independent with higher priority. Agent-1's next `claim-next` returns task B, not task C.
- Agent-2 (which cannot claim B because it's branch-blocked) gets task C.
- When all dependencies are `integrated`, the preference tier doesn't apply — normal priority ordering resumes.

---

## Phase 5: `POST /tasks/replan` — cycle detection and priority recomputation

**Files:**
- `server/src/routes/tasks.ts`
- `server/src/routes/tasks.test.ts`

**Work:**
1. Implement `POST /tasks/replan` endpoint.
2. Build a directed graph from all non-terminal tasks (`status NOT IN ('completed', 'failed', 'integrated')`). Each task is a node; each `task_dependencies` row is a directed edge.
3. Run Kahn's algorithm (topological sort via in-degree reduction):
   - Initialise in-degree counts for all nodes.
   - Seed the queue with zero-in-degree nodes.
   - Process: dequeue, append to sorted order, decrement in-degrees of dependents.
   - Nodes remaining after the queue empties are in cycles.
4. Mark cyclic tasks: set `status = 'cycle'` on all tasks involved in cycles.
5. Recompute priorities from the DAG using reverse topological order:
   - Leaf nodes (no dependents) keep their author-assigned priority unchanged.
   - Interior nodes accumulate: `priority = original_priority + sum(priority of all direct dependents)`.
   - Write computed priorities in a single transaction.
6. Return response:
   ```json
   {
     "ok": true,
     "replanned": 42,
     "cycles": [
       { "taskIds": [5, 8, 12], "titles": ["A", "B", "C"] }
     ],
     "maxPriority": 15,
     "roots": [3, 7]
   }
   ```
7. Add `POST /tasks/:id/reset` support for `cycle` status — allows moving cycle-resolved tasks back to `pending`.

**Acceptance criteria:**
- Three-node cycle (A→B→C→A) detected and all three marked `cycle`.
- Direct cycle (A↔B) detected.
- Acyclic portion is not affected by cycle marking.
- Priority accumulation: leaf with priority 10 causes its ancestor chain to accumulate that weight.
- Calling replan twice yields the same result (idempotent).
- `cycle` tasks are excluded from `claim-next`.
- `POST /tasks/:id/reset` on a `cycle` task moves it to `pending`.

---

## Phase 6: Integration with ingest and batch creation

**Files:**
- `server/src/routes/tasks.ts`
- `scripts/ingest-tasks.sh`

**Work:**
1. `POST /tasks/batch` accepts optional `?replan=true` query parameter. When set, calls the replan logic after batch insertion.
2. Update `ingest-tasks.sh` to call `POST /tasks/replan` after ingestion completes.
3. Ensure that tasks ingested with descending priority (e.g. phases 1–6 at priorities 10, 9, 8, 7, 6, 5) have their priorities recomputed by the DAG structure when dependencies are declared.

**Acceptance criteria:**
- Batch insert with `?replan=true` returns the replan summary alongside the created tasks.
- `ingest-tasks.sh` calls replan after ingestion.
- Phases 1–6 with dependencies (2→1, 3→2, etc.) get priorities recomputed so phase 1 has the highest accumulated priority.

---

## Phase 7: Tests

**Files:**
- `server/src/routes/tasks.test.ts`

**Work:**
All phases above include their own acceptance criteria. This phase is for integration-level tests that exercise the full lifecycle:

1. **Full branch-aware lifecycle**: Create tasks A→B→C with dependencies. Agent-1 completes A. Verify agent-1 can claim B but agent-2 cannot. Integrate A. Verify agent-2 can now claim B. Agent-2 completes B. Verify agent-2 can claim C but agent-1 cannot.
2. **Preferential claiming**: Create independent task X (priority 10) and dependent task B (priority 5, depends on A). Agent-1 completes A. Verify agent-1's `claim-next` returns B (chain continuation) not X (higher priority independent).
3. **Replan + claim interaction**: Create a batch with cycles. Replan. Verify cycled tasks are not claimable. Resolve cycle by editing dependencies. Reset cycled tasks. Replan again. Verify they become claimable.
4. **integrate-batch after merge**: Two agents complete separate tasks. Call `integrate-batch` for agent-1. Verify only agent-1's tasks are integrated. Agent-2's tasks remain `completed`.

**Acceptance criteria:**
- All integration tests pass.
- No regressions in existing task tests.
