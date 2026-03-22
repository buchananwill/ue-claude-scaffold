---
title: "sourcePath validation checks wrong branch during claim, blocking valid tasks"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: fixed
---

# sourcePath validation checks wrong branch during claim

## Problem

When an agent calls `POST /tasks/:id/claim` or `POST /tasks/claim-next`, the server validates that the task's `sourcePath` (plan file) exists in the bare repo. The branch lookup falls back to `'main'` when the agent isn't registered:

```typescript
const agentRow = db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agent) as ...;
const branch = agentRow?.worktree ?? 'main';
```

Plan files are committed to `docker/current-root` and merged into agent branches (`docker/agent-1`, `docker/agent-2`). They are not on `main`. When `claim-next` finds a candidate, it internally calls the claim validation which checks `existsInBareRepo(bareRepo, 'main', sourcePath)` — this fails, and the task is silently skipped in favour of the next candidate.

## Concrete incident

Task 33 (Text-Native Content Phase 2) has `sourcePath: 'plans/text-native-content-phase-2.md'`. This file exists on `docker/current-root` and both agent branches, but not on `main`. When agent-1 called `claim-next`, task 33 was the best candidate (correct priority, dependency met on agent-1's branch), but the sourcePath validation rejected it. Task 34 (Phase 3, which also depends on 32 but has no `sourcePath` or a different validation path) was offered instead — out of sequence.

## Root cause

Two overlapping issues:

1. **Fallback branch is `'main'`** — should be `'docker/current-root'` or the agent's own branch. The `main` branch in the bare repo may not even have plan files; they live on the docker branch hierarchy.

2. **`claim-next` doesn't surface the rejection reason** — when the SQL query finds a candidate but the claim validation fails (sourcePath not found), the task is silently skipped. The caller gets the next candidate with no indication that a better candidate was rejected. This makes debugging very difficult.

## Affected code paths

- `POST /tasks/:id/claim` (line ~1243): falls back to `'main'` when agent not registered
- `POST /tasks/claim-next` (line ~1171): delegates to claim logic internally; same branch resolution issue
- `POST /tasks/:id/reset` (line ~1284): uses `getValidationWorktree()` which returns `config.project.path` (the host project, not the bare repo) — inconsistent with the claim path
- `POST /tasks/batch` and `POST /tasks` creation (lines ~568, ~749): validate sourcePath at creation time using `existsInBareRepo` with a `planBranch` variable — need to verify this uses the correct branch too

## Proposed fix

1. Change the fallback branch from `'main'` to `'docker/current-root'` in the claim validation. This is the integration branch where all plan files are committed before being merged into agent branches.

2. Better: check the agent's own branch first (from registration), then fall back to `docker/current-root`. The agent's branch is a superset of `current-root` at launch time.

3. When `claim-next` rejects a candidate due to sourcePath validation, log it and try the next candidate rather than silently offering a worse match. Include the rejection reason in the response's diagnostic fields.

4. Audit all sourcePath validation call sites for branch consistency. The creation-time validation and claim-time validation should use the same branch resolution logic.
