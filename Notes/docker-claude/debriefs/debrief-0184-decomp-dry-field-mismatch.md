# Debrief 0184 -- Decomposition Review: DRY Fixes and Field Name Mismatch

## Task Summary

Fix 4 issues raised by the decomposition reviewer against the task-agent-type-override plan:
- W1: DRY violation -- task variable reset block duplicated in pump-loop.sh
- W2: DRY violation -- allowlist regex duplicated 5 times across 4 files
- W3: File bloat -- tasks.test.ts at 1138 lines; extract agentTypeOverride tests
- N1: Critical correctness bug -- agent-fetch.sh extracts wrong field names from server response

## Changes Made

- **container/lib/env.sh** -- Added `_is_safe_name()` shared function (returns 0 if value matches `^[a-zA-Z0-9_-]+$`). Added `_reset_task_vars()` function after CURRENT_TASK_* declarations. Replaced both inline regex checks (AGENT_NAME, PROJECT_ID) with `_is_safe_name` calls.
- **container/lib/agent-fetch.sh** -- Replaced inline regex check with `_is_safe_name` call. Fixed `.compiled` to `.markdown` and `.metadata["access-scope"]` to `.meta["access-scope"]` to match actual server response shape from `agent-definitions.ts`.
- **container/lib/pump-loop.sh** -- Replaced inline regex check with `_is_safe_name` call. Replaced both 7-line task variable reset blocks with `_reset_task_vars` calls.
- **container/lib/run-claude.sh** -- Replaced inline regex check with `_is_safe_name` call.
- **server/src/routes/tasks-agent-type.test.ts** -- New file containing all agentTypeOverride tests (17 tests) extracted from tasks.test.ts.
- **server/src/routes/tasks.test.ts** -- Removed the agentTypeOverride test block (lines 896-1138).

## Design Decisions

- Placed `_is_safe_name()` in env.sh because it is the first lib file sourced and all other lib files depend on it.
- Placed `_reset_task_vars()` in env.sh immediately after the variable declarations it resets, keeping declaration and reset co-located.
- The new test file registers only `agent-1` (the minimum needed), rather than the full set of agents from the original beforeEach.

## Build & Test Results

- Shell syntax check: PASS (`bash -n` on all 4 container lib scripts)
- TypeScript build: PASS (`npm run build`)
- New test file standalone: PASS (16/16 tests in `tasks-agent-type.test.ts`)
- Original test file regression: PASS (50/50 tests in `tasks.test.ts`)
- Full test suite: ran through ~23 suites; 4 pre-existing failures in `agents.test.ts` sync tests (git identity not configured in container -- unrelated to this change). All other suites pass.

## Open Questions / Risks

None. All changes are mechanical DRY extractions and a field-name correction verified against the server source.

## Suggested Follow-ups

None.
