---
title: "Branch-aware task lifecycle: completed vs integrated, dependency-preferential claiming"
priority: critical
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Branch-aware task lifecycle

## Problem

Tasks completed by one agent are only available on that agent's branch. The current system marks them `completed` and unblocks dependents for any agent to claim — but the claiming agent doesn't have the prerequisite work on its branch.

### Concrete incident (2026-03-21)

Text-Native Content phases 1–6 were ingested as tasks with descending priority (10, 9, 9, 8, 7, 6). Agent-1 claimed and completed Phase 1 (SQL schema, task 32). Agent-2 then claimed Phase 2 (Asset Exporter, task 33) — its dependencies showed as met (`completed`), but agent-2's branch didn't have Phase 1's code. Agent-2 wrote the exporter blind, without the schema it depends on.

### Root cause

`completed` conflates "the work is done" with "the work is available". In a multi-branch model these are different states. A task completed on `docker/agent-1` is only available to agent-1 until the branch is merged into `docker/current-root`.

## Design

### 1. New status: `integrated`

Extend the task status lifecycle:

```
pending → in_progress → completed → integrated
```

- `completed` — work is done, but only on the completing agent's branch. The `result.agent` field records which agent (and therefore which branch) has the work.
- `integrated` — work has been merged into `docker/current-root` and is available to all agents.

Schema change: add `'integrated'` to the status CHECK constraint.

### 2. Branch-aware dependency resolution

A task's dependencies are considered met for claiming purposes when:

- All dependencies are `integrated` (any agent can claim), OR
- All dependencies are `completed` by the **same agent** requesting the claim (the work is on that agent's branch)

Mixed cases (some deps `integrated`, some `completed` by the requesting agent) are also valid — as long as no dependency is `completed` by a *different* agent or still `pending`/`in_progress`.

Update the `claim-next` SQL and `claim` validation to implement this.

### 3. Dependency-preferential claiming

When `claim-next` selects a task for an agent, it should **prefer tasks whose dependencies were completed by that agent** over independent tasks, even if the independent tasks have equal or higher priority.

Rationale: if agent-1 completes a blocker that unblocks three dependent tasks, agent-1 should take those next. Otherwise agent-1 hoovers up other independent work, and the unblocked tasks can only go to agent-1 (since the prerequisite is `completed` not `integrated`). Meanwhile agent-2 is either idle or doing work that'll conflict later. The preference rule keeps dependent chains flowing on the branch that has the context.

Claiming priority order for a given agent:
1. Tasks whose dependencies were `completed` by this agent (branch-local chain continuation)
2. Tasks whose dependencies are all `integrated` (available to anyone)
3. Independent tasks (no dependencies)

Within each tier, use the existing priority ordering.

### 4. Integration lifecycle

Integration happens when branches are merged into `docker/current-root`. This can be triggered by:

- Manual merge (interactive session merges agent work)
- `POST /tasks/:id/integrate` endpoint (marks a single task as integrated)
- `POST /tasks/integrate-batch` endpoint (marks all tasks completed by a given agent as integrated, called after a branch merge)

The merge-then-integrate flow:
1. User merges `docker/agent-1` into `docker/current-root`
2. User calls `POST /tasks/integrate-batch` with `{"agent": "agent-1"}`
3. All tasks completed by agent-1 move to `integrated`
4. Dependent tasks become claimable by any agent

### 5. Dashboard

- Show `completed` tasks with the completing agent's name (e.g. "Completed (agent-1)")
- Show `integrated` tasks with a distinct badge
- Blocked-by indicators should distinguish "blocked by incomplete task" from "blocked by work on another branch"

## Migration

- Add `'integrated'` to status CHECK constraint
- All currently `completed` tasks are effectively integrated (from previous runs where branches were merged). Run a one-time migration to set their status to `integrated`.

## Interaction with existing systems

- **File ownership**: unchanged. Files are still owned by the agent that claimed the task.
- **Priority replan** (issue 012): `integrated` tasks are terminal like `completed` — excluded from the DAG.
- **Cycle detection**: unchanged — operates on non-terminal statuses.
