# Phase 1: Dependencies and audit

Foundation phase. Add the UUID package and produce a scratch audit of every current cross-table reference that later phases will consume. No production code changes.

## Files

- `server/package.json` (modify — add `uuid@^11`)
- `plans/schema-hardening-v25/audit-scratch.md` (new — scratch notes for execution, deleted in Phase 13)

## Work

1. Add the UUID v7 generator dependency: in `server/`, run `npm install uuid@^11`. Confirm `@types/uuid` is bundled with that version (uuid v11 ships its own types); if not, run `npm install --save-dev @types/uuid`.
2. Verify `server/package.json` shows `"uuid"` in `dependencies`. Run `npm run typecheck` from `server/` — no new errors should appear from the dependency addition alone.
3. Audit every current cross-table reference that this plan will migrate. For each target, grep the codebase and catalogue (a) the column's current name in `server/src/schema/tables.ts`, (b) every query file that reads or writes it, (c) every test file that exercises it, (d) any raw SQL that references it by string name. Targets: `tasks.claimedBy`, `files.claimant`, `buildHistory.agent`, `ubtLock.holder`, `ubtQueue.agent`, `messages.agent`, `roomMembers.member`, `teamMembers.agentName`, `chatMessages.sender`.
4. For `messages.agent` specifically, determine whether the column is semantically an agent reference or a free-form label. Inspect how it is populated and read. Record the finding in the audit file. This decision feeds Phase 2 step 5.
5. Write the audit results into `plans/schema-hardening-v25/audit-scratch.md`. Structure: one section per target column, bullets for call sites. Commit the audit file alongside the phase work — it informs Phases 5–10.
6. Commit the dependency addition and the audit file. Message: `Phase 1: Add uuid dependency and cross-table reference audit for schema hardening V2.5`.

## Acceptance criteria

- `server/package.json` lists `uuid` with a version `^11.x.x` or higher in `dependencies`.
- `npm run typecheck` from `server/` exits 0 with no new errors.
- `plans/schema-hardening-v25/audit-scratch.md` exists and contains one catalogue section per target column, with file:line references for every read and write.
- The audit file records a decision for `messages.agent`: either "referential — rename to `agentId`" or "free-form label — keep as `agent text`, add new nullable `agentId` alongside".
- Commit exists on the current branch with the two changes.
