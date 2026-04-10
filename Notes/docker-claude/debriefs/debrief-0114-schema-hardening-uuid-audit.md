# Debrief 0114 -- Schema Hardening V2.5 Phase 1: UUID Dependency and Cross-Table Reference Audit

## Task Summary

Phase 1 of the schema hardening V2.5 plan: add the `uuid` package (v11+) as a dependency to `server/`, verify it typechecks, and produce a thorough audit of every cross-table agent-reference column that will be migrated in subsequent phases.

## Changes Made

- **server/package.json** -- Added `uuid: ^11.1.0` to dependencies (npm install uuid@^11).
- **server/package-lock.json** -- Updated lockfile with uuid v11.1.0 and its transitive dependencies.
- **plans/schema-hardening-v25/audit-scratch.md** -- Created. Contains one section per target column (10 sections total) with file:line references for every read, write, route usage, test, and raw SQL reference.
- **Notes/docker-claude/debriefs/debrief-0114-schema-hardening-uuid-audit.md** -- This file.

## Design Decisions

1. **messages.fromAgent decision**: Determined this is referential (not free-form). The column is always populated from the `X-Agent-Name` HTTP header which corresponds to `agents.name`. All filters use exact match. The `'unknown'` fallback is a sentinel for anonymous requests. Recommendation: rename to `agentId` and make it a proper FK to `agents.id` once agents get UUID PKs.

2. **Column name discrepancy**: The plan references `messages.agent` but the actual schema column is `messages.fromAgent` (DB column `from_agent`). The audit covers the actual column name. There is no column literally named `agent` on the messages table -- the plan likely refers to `fromAgent`.

3. **messages.claimedBy**: Also audited since it is a separate agent-reference column on the messages table (claimed_by column). This was listed as a target in the tasks table but also exists on messages.

## Build & Test Results

- `npm run typecheck` from `server/` exits 0 with no errors after uuid installation.
- uuid v11.1.0 ships its own TypeScript types (found at `node_modules/uuid/dist/esm/index.d.ts`); no `@types/uuid` needed.

## Open Questions / Risks

- The plan targets `messages.agent` but the actual column is `messages.fromAgent` / `from_agent`. Subsequent phases should reference the correct column name.
- Several raw SQL strings in `queries/tasks-claim.ts` reference `f.claimant` and `f2.claimant` directly -- these will need updating when the column is renamed.
- The `ubtQueue` dequeue uses raw SQL `DELETE FROM ubt_queue ... RETURNING *` which returns the column as `agent` -- the consuming code accesses `next.agent` directly from the raw result.

## Suggested Follow-ups

- Phase 2 should update the column references to use the correct names identified in this audit.
- The `test-utils.ts` DDL strings will need updating whenever schema columns are renamed.
- Consider whether `messages.claimedBy` should also become a UUID FK or remain text (it follows the same pattern as `tasks.claimedBy`).
