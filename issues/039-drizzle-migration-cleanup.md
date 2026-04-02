---
title: Post-migration cleanup - project-id decorator and utility extraction
priority: low
reported-by: interactive session
date: 2026-04-02
---

Two loose ends from the Drizzle migration that don't affect correctness but leave the codebase inconsistent.

## 1. Routes manually extract `x-project-id` instead of using `request.projectId`

The `project-id` plugin (`src/plugins/project-id.ts`) decorates every request with a validated `projectId` property. However, 9 call sites across 5 route files still extract the header manually:

- `agents.ts` (1)
- `coalesce.ts` (3)
- `files.ts` (1)
- `sync.ts` (1)
- `tasks.ts` (3)

Each does `(request.headers['x-project-id'] as string) || 'default'` instead of reading `request.projectId`. The middleware runs and validates regardless, so this is safe but redundant. The decorator value is never actually read.

**Fix:** Replace all manual header extractions with `request.projectId`. Remove the fallback `|| 'default'` since the middleware already defaults.

## 2. Utility functions not extracted to `utils.ts`

The plan called for moving `hasValue`, `validateFilePaths`, and `unknownFields` from `routes/tasks-files.ts` to a dedicated `src/utils.ts`. They remain in the route file. These are pure validation helpers with no DB or route dependency.

**Fix:** Move to `src/utils.ts` and update imports.
