# Phase 5: Agents query layer

Rewrite `server/src/queries/agents.ts` to match the new schema: every function that takes an agent name also takes a `projectId`, soft-delete replaces hard-delete, registration generates and reactivates UUIDs, and `getProjectId` is removed.

Expected typecheck fan-out: this phase will surface compile errors at every call site of the old function signatures. Those call sites are fixed in Phases 8–10. Do not start Phase 6 until this phase's file compiles in isolation (the rest of the codebase may still fail typecheck until Phase 13).

## Files

- `server/src/queries/agents.ts` (modify)

## Work

1. Add `import { v7 as uuidv7 } from 'uuid';` at the top of the file.
2. Add a required `projectId: string` parameter immediately after `db` on every exported function that takes a `name: string`: `getByName`, `updateStatus`, `softDelete`, `getWorktreeInfo`. Rewrite where-clauses as `and(eq(agents.projectId, projectId), eq(agents.name, name))`.
3. Delete `getProjectId(db, name)` entirely. Its semantics are ambiguous post-scoping; callers must use `request.projectId`.
4. Delete `hardDelete(db, name)`. Soft-delete replaces it. If a future vacuum tool needs raw delete, it will be a new function explicitly named `vacuumDeleteAgent` or similar — out of scope here.
5. Delete `deleteAll(db)`. It is unsafe cross-project. Replace with `deleteAllForProject(db, projectId)` that sets `status = 'deleted'` on every non-deleted agent in the project and returns the updated row count.
6. Rewrite `softDelete` to set `status = 'deleted'` (not `'stopping'`). The stopping-status semantics move to a new function created in the next step.
7. Add a new `stopAgent(db, projectId, name)` function that sets `status = 'stopping'`. This preserves the existing `_watch_for_stop` polling behavior in containers — the server-side state a running container polls against must remain `'stopping'`, not `'deleted'`, so the container knows it was asked to stop and can run its own shutdown sequence before its row is soft-deleted.
8. Rewrite `register(db, opts)`:
   - Generate a UUID v7 via `uuidv7()` for new rows. Pass it in the insert values.
   - Change the upsert target to `[agents.projectId, agents.name]` (matches the new composite unique constraint).
   - On conflict, keep the existing `id` by omitting it from the `set` clause: `onConflictDoUpdate({ target: [agents.projectId, agents.name], set: { worktree, planDoc, status: 'idle', mode, registeredAt: sql\`now()\`, containerHost: sql\`COALESCE(excluded.container_host, ${agents.containerHost})\`, sessionToken } })`. Omit `id` and `projectId` from the set clause — the conflict target already scopes them.
   - If Drizzle's ON CONFLICT on a composite unique constraint does not work in PGlite (verify at runtime in Phase 12), fall back to a SELECT-then-INSERT-or-UPDATE inside `db.transaction`. Keep the fallback hidden behind the existing `register` signature so callers are unaffected.
   - The returned value continues to include `sessionToken`, which is rotated on every call.
9. Rewrite `getActiveNames(db, projectId)` with a required `projectId` and filter `and(ne(agents.status, 'stopping'), ne(agents.status, 'deleted'), eq(agents.projectId, projectId))`. Deleted agents are not "active" by any definition.
10. Add a new helper `getByIdInProject(db, projectId, id)` for callers that hold a UUID and want to verify it still belongs to the expected project. Where-clause: `and(eq(agents.id, id), eq(agents.projectId, projectId))`. Returns the row or null.
11. Leave `getByToken(db, sessionToken)` unchanged — session tokens are globally unique by construction.
12. Commit. Message: `Phase 5: Rewrite queries/agents.ts for project-scoped identity, soft-delete, and UUID v7 registration`.

## Acceptance criteria

- `server/src/queries/agents.ts` imports `v7 as uuidv7` from `uuid`.
- `getByName`, `updateStatus`, `softDelete`, `getWorktreeInfo` all take `projectId` as a required parameter after `db`.
- `softDelete` sets `status = 'deleted'`.
- `stopAgent(db, projectId, name)` exists and sets `status = 'stopping'`.
- `register()` generates a UUID v7 for new rows and upserts on the composite `(projectId, name)` target.
- `getActiveNames` takes `projectId` and excludes both `'stopping'` and `'deleted'` rows.
- `getByIdInProject(db, projectId, id)` exists.
- `getProjectId`, `hardDelete`, `deleteAll` are gone.
- `deleteAllForProject(db, projectId)` exists and returns a row count.
- Running `tsc --noEmit server/src/queries/agents.ts` (or equivalent targeted typecheck) surfaces no errors in the file itself. Errors elsewhere in the codebase from the signature changes are expected and are addressed in later phases.
- Commit exists.
