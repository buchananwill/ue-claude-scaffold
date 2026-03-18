---
title: Server API Gaps — CRUD Completeness & Test Coverage
priority: 0
---

## Context

The coordination server has grown organically with create/read and lifecycle endpoints but is missing update, delete, and reset operations needed for day-to-day task management. Several recently-added endpoints also lack test coverage.

## Phase 1: Task CRUD Completeness

### 1a. `PATCH /tasks/:id` — Edit pending task metadata

File: `server/src/routes/tasks.ts`

- Updatable fields: `title`, `description`, `sourcePath`, `acceptanceCriteria`, `priority`
- Partial update — only set fields present in the request body
- Only allowed when status is `pending` — return 409 if claimed/in_progress/completed/failed
- If `sourcePath` is being changed, re-run the committed-file validation (same as POST /tasks)

### 1b. `POST /tasks/:id/reset` — Reset completed/failed task to pending

File: `server/src/routes/tasks.ts`

- Only allowed when status is `completed` or `failed` — return 409 otherwise
- Clears: `claimed_by`, `claimed_at`, `completed_at`, `result`, `progress_log`
- Sets status back to `pending`
- Re-validates `sourcePath` against the staging worktree (same check as POST /tasks) — the file may have been removed since the task was originally created

## Phase 2: Message Cleanup Endpoints

### 2a. `DELETE /messages/:id` — Delete a single message

File: `server/src/routes/messages.ts`

- Deletes by ID, returns 404 if not found

### 2b. `DELETE /messages/:channel` — Purge a channel

File: `server/src/routes/messages.ts`

- Optional query param: `?before=<id>` — delete messages with id < value (keep recent)
- Without `before`, deletes all messages in the channel
- Returns `{ ok: true, deleted: <count> }`

## Phase 3: Test Coverage

File: `server/src/routes/tasks.test.ts`

Add tests for all new and recently-added endpoints:

- `PATCH /tasks/:id` — success, partial update, reject non-pending, reject invalid sourcePath
- `POST /tasks/:id/reset` — success from completed, success from failed, reject pending/claimed
- `DELETE /tasks/:id` — success, reject claimed/in_progress, 404 for missing
- `DELETE /tasks?status=completed` — success, reject without status param, reject claimed/in_progress
- `POST /tasks` with `sourcePath` validation — reject uncommitted path (needs a test git repo in the fixture)
- `POST /tasks/:id/claim` with `sourcePath` re-validation — reject missing path in bare repo

File: `server/src/routes/messages.test.ts` (new file)

- `DELETE /messages/:id` — success, 404 for missing
- `DELETE /messages/:channel` — purge all, purge with `?before=`, empty channel

### Test fixture note

The sourcePath validation tests need a temporary git repo with committed files. Extend `createTestConfig` / `createTestApp` in `test-helper.ts` to set up a temp git repo with a known committed file, and point `stagingWorktreePath` and `bareRepoPath` at it.
