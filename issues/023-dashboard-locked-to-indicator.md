---
title: "Dashboard should show 'locked to' agent instead of 'blocked' for branch-dependent tasks"
priority: medium
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Dashboard should show "locked to" agent instead of "blocked" for branch-dependent tasks

## Problem

The dashboard shows tasks as "blocked" when their dependencies are `completed` but not `integrated`. This is misleading — the task isn't blocked in the absolute sense, it's just only claimable by the specific agent whose branch has the prerequisite work.

The dashboard is a user-facing tool, not an agent-facing one. Users will never be on an agent's branch directly. Showing "blocked" implies the task is stuck and needs intervention, when in reality it's correctly queued for the right agent.

## Concrete example

Task 33 (Phase 2) depends on task 32 (Phase 1, completed by agent-1). The dashboard shows task 33 with red blocked indicators and `blockReasons: ["blocked by work on another branch: #32"]`. From the user's perspective this looks like an error. In reality, agent-1 can claim it — it's just locked to agent-1's branch until task 32 is integrated.

## Proposed design

### 1. New indicator: "locked to"

When a task's dependencies are all met but only on specific agent branches (i.e. `completed` not `integrated`), show a distinct tag:

- **"Locked to: agent-1"** — only agent-1 can claim this task right now
- **"Locked to: agent-1, agent-3"** — multiple agents could claim it (e.g. deps completed by different agents that each satisfy a subset, or the same agent completed all deps)

This should be visually distinct from both "blocked" (red, stuck) and freely "pending" (green, anyone can claim).

### 2. Reserve "blocked" for genuinely stuck tasks

"Blocked" should only appear when:
- A dependency is `pending`, `in_progress`, `failed`, or `cycle` — the prerequisite work isn't done at all
- A file ownership conflict prevents any agent from claiming the task

### 3. API changes

The `GET /tasks` and `GET /tasks/:id` responses should include a `lockedTo` field alongside `blockedBy`:

```json
{
  "blockedBy": [],
  "lockedTo": ["agent-1"],
  "blockReasons": []
}
```

`lockedTo` is populated by checking which agents completed the non-integrated dependencies. Empty array means freely claimable (all deps integrated or no deps).

### 4. Dashboard rendering

- **Freely pending** (no deps or all integrated): current green pending badge
- **Locked to agent(s)**: new badge, e.g. amber/blue with agent name(s) — task is progressing correctly, just branch-scoped
- **Blocked**: red badge — task is genuinely stuck and may need user attention
