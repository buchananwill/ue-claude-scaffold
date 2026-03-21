---
title: "Task dependencies: dependsOn relation and claim-time enforcement"
priority: high
reported-by: interactive-session
date: 2026-03-20
status: done
---

# Task dependencies: dependsOn relation and claim-time enforcement

## Problem

Two parallel agents claimed tasks where one depends on the other's output. Task 25 ("STwoAxisGridView
Layout and Animation Evolution") depends on task 24 ("Slate Tweening Framework") — the animation
system can't exist without the tweening primitives it builds on. The file-lock system only prevents
overlapping *file* writes, not *logical* dependencies between tasks.

This will happen repeatedly with any plan that has sequential phases broken into separate tasks.

## Concrete incident

- Agent-1 claimed task 24 (tweening framework, priority 5)
- Agent-2 claimed task 25 (animation evolution, priority 2) which depends on task 24's output
- Task 25 cannot succeed until task 24 is complete and merged

## Proposed design

### 1. `task_dependencies` join table

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id != depends_on)
);
CREATE INDEX idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_task_deps_dep ON task_dependencies(depends_on);
```

### 2. API: creating dependencies

`POST /tasks` and `POST /tasks/batch` accept `dependsOn: number[]` — an array of existing task IDs.
The server inserts rows into `task_dependencies`. Validation:

- Each referenced task ID must exist.
- No self-references.
- Cycle detection (at least direct: A depends on B, B depends on A).

For batch creation where tasks reference each other by position (not yet assigned IDs), accept
a `dependsOnIndex` field — zero-based index into the batch array. The server resolves to real IDs
after insertion.

### 3. API: reading dependencies

`GET /tasks` and `GET /tasks/:id` return:
- `dependsOn: number[]` — IDs this task depends on (from the join table)
- `blockedBy: number[]` — subset of `dependsOn` where the dependency's status is not `completed`

### 4. Claim-time enforcement

`POST /tasks/claim-next` query must exclude tasks with unmet dependencies:

```sql
-- Exclude tasks that have any non-completed dependency
WHERE t.id NOT IN (
  SELECT d.task_id FROM task_dependencies d
  JOIN tasks dep ON dep.id = d.depends_on
  WHERE dep.status != 'completed'
)
```

`POST /tasks/:id/claim` checks the same condition and returns 409 with the blocking task IDs if
any dependency is unmet.

### 5. Dashboard

- Show dependency status per task (e.g. "Blocked by #24").
- Dependency links are clickable.
- Blocked tasks are visually distinct from freely pending tasks.

### 6. Task creation protocol

When creating a batch of tasks from a multi-phase plan, dependencies must be declared. This is a
mandatory part of the protocol: if phase 2 depends on phase 1, the task for phase 2 must have
`dependsOn: [<phase-1-task-id>]`. For batch creation, use `dependsOnIndex` to reference within
the batch.

Document this in the resort game CLAUDE.md task creation section.

## Migration

Existing tasks have no rows in `task_dependencies` — they remain freely claimable. The relation is
additive.
