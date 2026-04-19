# Phase 5 — GET /tasks filtering and dashboard

Part of [Task Agent Type Override](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** `GET /tasks` supports an `agentTypeOverride` query filter. The dashboard tasks table displays the override
column.

**Types / APIs:**

```ts
// GET /tasks?agentTypeOverride=container-reviewer,container-implementer
// Comma-separated list of override values to match.
// Include the sentinel "__default__" to also match tasks with a null override
// (i.e., tasks that fall back to the container's default AGENT_TYPE).
```

**Convention to follow:** the existing `agent` filter in [server/src/routes/tasks.ts:94](../../server/src/routes/tasks.ts) and [server/src/queries/tasks-core.ts:80](../../server/src/queries/tasks-core.ts) parses a comma-separated value via `parseCommaFilter` and uses a single `__unassigned__` sentinel for NULL-matching. Mirror that shape exactly for `agentTypeOverride`: comma-separated values, one sentinel (`__default__`) for the null case, no paired "any non-null" sentinel.

**Work:**

- Add `agentTypeOverride` to `TaskListQueryInput` and `ParsedTaskListQuery` in `server/src/routes/tasks.ts`.
- In `parseTaskListQuery`, parse `agentTypeOverride` via `parseCommaFilter`, then validate each value: accept `__default__` verbatim, otherwise require `isValidAgentName` (same helper as Phase 2).
- Thread the parsed array into `buildFilterConditions` in `server/src/queries/tasks-core.ts`, following the same `__unassigned__` pattern at line 80 — split out the sentinel, combine with `isNull`/`eq`/`inArray` via `or` as appropriate.
- Add an `Agent Type` column to the dashboard tasks table in `dashboard/src/`.

**Verification:** `npm test` passes. `GET /tasks?agentTypeOverride=container-reviewer` returns only tasks with that override. `GET /tasks?agentTypeOverride=__default__` returns tasks with a null override. `GET /tasks?agentTypeOverride=container-reviewer,__default__` returns both. Invalid values return 400 with a clear message. The dashboard shows the column with appropriate styling (badge or text).
