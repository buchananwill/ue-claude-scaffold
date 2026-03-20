---
title: "Dependency graph cycle detection and priority recomputation"
priority: high
reported-by: interactive-session
date: 2026-03-20
---

## Problem

Task priorities are currently assigned manually at creation time. This means:

1. A task blocking 15 downstream tasks has the same priority as an isolated leaf task if both were given `priority: 0`.
2. Cycle detection only catches direct A<->B mutual dependencies in batch creation. Longer cycles (A->B->C->A) slip through and cause silent deadlocks — all cyclic tasks stay `pending` forever since `claim-next` filters on unmet dependencies.
3. The design team has no visibility into which tasks form cycles and need to be rethought.

## Proposal

Add a `POST /tasks/replan` endpoint that:

### 1. Builds a directed graph from all non-terminal tasks

Query `task_dependencies` joined with `tasks` where `status NOT IN ('completed', 'failed')`. Each task is a node; each `depends_on` row is a directed edge.

### 2. Detects cycles (Tarjan's or Kahn's algorithm)

- **Kahn's algorithm** (topological sort via in-degree reduction) is the better fit here: it naturally separates the acyclic portion from the cyclic remainder, and the topological order is needed for the priority accumulation anyway.
- All tasks remaining after Kahn's algorithm completes are in cycles.

### 3. Marks cyclic tasks

- Add `'cycle'` to the tasks status CHECK constraint (schema migration v7 -> v8).
- Set `status = 'cycle'` on all tasks involved in cycles.
- Return the cycle groups in the response so the design team can see which tasks need restructuring (split, reorder, or remove edges).
- Cyclic tasks are invisible to `claim-next` (already filtered by `status = 'pending'`).
- Design team resolves cycles by editing dependencies (`PATCH /tasks/:id` with new `dependsOn`), then calls `POST /tasks/replan` again.
- Consider: `POST /tasks/:id/reset` should accept `'cycle'` status too, so resolved tasks can be moved back to `pending`.

### 4. Recomputes priorities from the DAG structure

Using the topological order from Kahn's:

- **Leaf nodes** (no dependents — nothing depends on them) keep their author-assigned priority unchanged. If a design team member sets a leaf to priority 10, that's respected.
- **Interior nodes** accumulate: `weight = own original priority + sum(weight of all tasks that directly depend on this task)`.
- Walk the topological order in reverse (leaves first, roots last).
- Write the computed weights as the new `priority` values via a single `UPDATE` per task inside a transaction.

This means a high-priority leaf (e.g. priority 10) percolates upward — its ancestors inherit that weight plus all other dependents. Workers naturally pick the most critical-path work first, and the design team retains control over leaf-level importance.

### 5. Response shape

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

## Integration points

- **After batch insert**: `POST /tasks/batch` could optionally call replan automatically (opt-in via `?replan=true` query param, or always-on).
- **Dashboard**: surface `cycle` status with a distinct badge and a "resolve" action that links to the dependency editor.
- **`ingest-tasks.sh`**: call `POST /tasks/replan` after ingestion completes.

## Schema change

```sql
-- v8: add 'cycle' to task status enum
-- In tasks table CHECK constraint:
CHECK (status IN ('pending','claimed','in_progress','completed','failed','cycle'))
```

## Scope

- `POST /tasks/replan` endpoint in `server/src/routes/tasks.ts`
- Schema migration in `db.ts` (v7 -> v8)
- Tests: cycle detection (3+ node cycles), priority accumulation correctness, idempotency (calling replan twice yields same result)
- Dashboard: `cycle` status badge (separate issue)
