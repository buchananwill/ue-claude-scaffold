# Debrief 0085 -- Phase 11 Review Cycle 4 Fixes

## Task Summary
Fix five review warnings from Phase 11 cycle 4: unused import, duplicate regex, role validation, resolveProject catch-all, and leader-first assertion.

## Changes Made
- **server/src/team-launcher.ts**: Removed unused `agentBranchFor` from import (W1).
- **server/src/routes/teams.ts**: Removed duplicate `TEAM_ID_RE` constant, replaced usage with already-imported `AGENT_NAME_RE` (W2). Updated `resolveProject` catch to log the error and differentiate missing-project errors from other failures (W2).
- **scripts/launch-team.sh**: Added `_ROLE` format validation with `^[a-zA-Z0-9 _-]{1,128}$` regex (W3). Added leader-first assertion that checks `members[0].isLeader == true` before launching any containers (W1).

## Design Decisions
- For the resolveProject catch (fix 4), checking for "not found"/"unknown"/"Unknown" in the error message to distinguish missing-project errors. Other errors get a more descriptive message including the original error text.
- For the leader-first assertion (fix 5), checking once before the loop rather than restructuring the entire loop, since the server already guarantees leader-first ordering.

## Build & Test Results
Pending initial build.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
