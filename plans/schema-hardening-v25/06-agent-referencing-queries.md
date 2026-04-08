# Phase 6: Agent-referencing query layer

Rewrite every query file that reads or writes an agent reference column. All agent references are now `agent_id uuid` (not text), and every query gains an explicit `projectId` parameter so cross-project mutations cannot happen by accident.

## Files

- `server/src/queries/tasks-lifecycle.ts` (modify)
- `server/src/queries/files.ts` (modify)
- `server/src/queries/coalesce.ts` (modify)
- `server/src/queries/ubt.ts` (modify)

## Work

1. `server/src/queries/tasks-lifecycle.ts` — add a required `projectId: string` to `releaseByAgent` and `releaseAllActive`. Rename `releaseByAgent` to accept `agentId: string` (UUID) instead of the old `agent: string` name — the text agent name no longer exists on `tasks`. Rewrite each where-clause to match on `tasks.claimedByAgentId` and add `eq(tasks.projectId, projectId)`. Import `and` from `drizzle-orm` if not already present.
2. `server/src/queries/files.ts` — apply the same transformation to `releaseByClaimant` (rename to `releaseByClaimantAgentId`) and `releaseAll`. Both take `projectId`; the former also takes `agentId`. Queries match on `files.claimantAgentId` and `files.projectId`.
3. `server/src/queries/coalesce.ts` — `pausePumpAgents`, `countActiveTasksForAgent`, and `getOwnedFiles` currently accept `agent: string`. Change each to `agentId: string` where the parameter refers to a specific agent, and use the UUID column (`tasks.claimedByAgentId` / `files.claimantAgentId`) in the where-clauses. `pausePumpAgents(db, projectId?)` currently takes an optional `projectId`; tighten it to required. Leave `countActiveTasks`, `countPendingTasks`, `countClaimedFiles`, `releaseAllFiles`, `resumePausedAgents`, `getPausedAgentNames`, `getInFlightTasks` as-is if they already take `projectId` as optional — but change optional to required for any of them that currently accept no project scoping, to match the "no implicit default" rule.
4. `server/src/queries/ubt.ts` — grep the file for references to `ubtLock.holder` and `ubtQueue.agent`. Rename column references to `ubtLock.holderAgentId` and `ubtQueue.agentId`. Update all query writers and readers. The 60-second stale-lock sweep (referenced in `CLAUDE.md`) uses a JOIN on `agents` — ensure the JOIN is on `agents.id = ubt_lock.holder_agent_id`, not on name. Every function that operates on a specific agent takes `agentId: string` (UUID), not `agent: string`. Functions that operate on a specific project take a required `projectId: string`.
5. Verify none of the four files still reference the old text-column names (`claimed_by`, `claimant`, `holder`, `agent` on these tables, `agent_name`). Grep each for the old names; zero results expected.
6. Commit. Message: `Phase 6: Rewrite agent-referencing queries for UUID FKs and required project scoping`.

## Acceptance criteria

- `server/src/queries/tasks-lifecycle.ts` — `releaseByAgent` renamed or signature-updated to take `(db, projectId, agentId)`; `releaseAllActive` takes `(db, projectId)`; all where-clauses filter by `projectId`.
- `server/src/queries/files.ts` — `releaseByClaimantAgentId(db, projectId, agentId)` and `releaseAll(db, projectId)` exist; no references to `files.claimant` (the text column).
- `server/src/queries/coalesce.ts` — all functions that target a specific agent take `agentId` (UUID); all project-aware functions take `projectId` as required.
- `server/src/queries/ubt.ts` — all references to `ubt_lock.holder` and `ubt_queue.agent` are gone; JOINs use `agents.id = ubt_lock.holder_agent_id`.
- No file under `server/src/queries/` references any old agent text column by name (`claimed_by`, `claimant`, `holder`, `ubt_queue.agent`, `agent_name`).
- Targeted typecheck of each file shows no errors in the file itself. Caller errors elsewhere are expected.
- Commit exists.
