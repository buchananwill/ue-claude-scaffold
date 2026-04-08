# Phase 13: Verification, documentation, and cleanup

Gate phase. Run typecheck and the full test suite against the final code; update `CLAUDE.md` to reflect the new invariants; delete the absorbed plan file and the scratch audit file; prepare the final commit.

## Files

- `server/` (verify — no code changes expected; this phase is gates and docs)
- `CLAUDE.md` (modify)
- `plans/project-id-foreign-keys.md` (delete)
- `plans/schema-hardening-v25/audit-scratch.md` (delete)
- Root commit

## Work

1. Run `cd server && npm run typecheck`. Expect 0 errors across all files including tests. If errors remain, stop and fix them before proceeding. Do not ship with red typecheck.
2. Run `cd server && npm test`. Expect every test to pass. Investigate and fix any failure — do not mask, skip, or `.todo` tests. Pay particular attention to:
   - Regression tests from Phase 12 (cross-project isolation, session token, reactivation, Option D authorship).
   - Any test that exercises the migration flow indirectly by creating isolated PGlites.
   - Tests that rely on `drizzle-test-helper.ts` — the helper runs the same migration files used in production, so Phase 3 errors would surface here.
3. Validate container shell syntax: `bash -n container/lib/registration.sh`. Exit 0 expected.
4. Update `CLAUDE.md` in the repo root:
   - In the "Server Code Conventions" section, add: agent identity is `agents.id` (UUID v7); `(project_id, name)` is a unique human-readable slot, not an identity. Every agent query must take an explicit `projectId`. Agents are soft-deleted via `status = 'deleted'`; hard deletion is a vacuum-class operation not performed in normal flow.
   - Under the `/agents/*` route listing, update the DELETE route description: single-phase soft-delete, optional `sessionToken` query parameter returns 409 on mismatch.
   - Under the coordination server summary, add: FK constraints enforce cross-table integrity; `project_id` is a foreign key to `projects.id` on every data table.
   - Under the chat/rooms section (if present, else add it): `room_members` is agent-only; the operator authors messages without being a member; `chat_messages` carries an `author_type` discriminator (`agent` / `operator` / `system`).
5. Delete `plans/project-id-foreign-keys.md`. Its intent is fully absorbed into this plan's Phase 3 (migration file 0003, the project-id orphan cleanup section) and Phase 3 file 0004 (the `project_id` FK additions).
6. Delete `plans/schema-hardening-v25/audit-scratch.md`. Its content informed Phases 5–10 and is no longer load-bearing.
7. Stage all changes (`git add` the relevant files — schema, migrations, query files, routes, container script, tests, CLAUDE.md; `git rm` the two deletions; leave the plan directory files staged from each prior phase's commits). Run `git status` and eyeball the list for anything unexpected.
8. Final commit. Message: `Phase 13: Verify typecheck/tests, update CLAUDE.md, delete absorbed plans`.

## Acceptance criteria

- `cd server && npm run typecheck` exits 0 with no errors.
- `cd server && npm test` exits 0 with every test passing.
- `bash -n container/lib/registration.sh` exits 0.
- `CLAUDE.md` contains the new conventions for agent identity, soft-delete, session-token DELETE, and Option D chat/rooms semantics.
- `plans/project-id-foreign-keys.md` no longer exists.
- `plans/schema-hardening-v25/audit-scratch.md` no longer exists.
- `git status` is clean except for the staged Phase 13 changes; no uncommitted tracked changes remain.
- Final commit exists on the branch.
