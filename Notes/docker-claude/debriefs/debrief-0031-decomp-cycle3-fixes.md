# Debrief 0031 -- Decomposition Review Cycle 3 Fixes

## Task Summary

Apply consolidated review findings from decomposition review cycle 3. Nine fixes total: 4 blocking (correctness/security), 5 warning (style/robustness).

## Changes Made

- **server/src/routes/build.ts** -- Changed `resolveProjectForAgent` to return `{ project, projectId }` tuple, eliminating redundant DB lookup in `prepareBuildOrTest`.
- **server/src/tasks-validation.ts** -- Fixed `synced` flag: now only set to `true` after confirming the file exists post-sync, not merely when the sync call succeeds.
- **server/src/routes/agents.ts** -- Added `AGENT_NAME_RE` import and validation on POST /agents/register; added `reply` to handler signature.
- **server/src/routes/tasks-lifecycle.ts** -- Added `AGENT_NAME_RE` import and validation on POST /tasks/integrate-batch agent parameter.
- **server/src/routes/tasks-claim.ts** -- Truncated sourcePath to 256 chars in error messages to prevent excessively long responses.
- **launch.sh** -- Simplified `_lc_env` loop to direct array assignment; fixed ROOT_BRANCH warning to only fire on env override (not config); added ROOT_BRANCH format validation; added `_MEMBER_ROLE` format validation.

## Design Decisions

- For fix 2 (synced flag), used the cleaner restructure where `synced = true` is set only in the branch where the file was initially missing, auto-sync ran, and the post-sync check confirmed availability.
- For fix 9 (sourcePath truncation), used Unicode ellipsis character directly in the string literal.

## Build & Test Results

- **Server build**: Clean (tsc, no errors)
- **Shell validation**: `bash -n launch.sh` passes
- **Tests**: 487 passed, 0 failed

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
