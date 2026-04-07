# Debrief 0045 -- Phase 1 Review Findings Cycle 1

## Task Summary

Fix all blocking and warning review findings from three reviewers on the Phase 1 bash library files (colors.sh, curl-json.sh, validators.sh, compose-detect.sh).

## Changes Made

- **scripts/lib/colors.sh** -- Renamed `status_color` to `_status_color` (STYLE B1). Changed shebang to `#!/bin/bash` (STYLE B2). Updated header comment.
- **scripts/lib/curl-json.sh** -- Changed shebang to `#!/bin/bash` (STYLE B2). Added jq validation of POST body before sending (CORRECTNESS B2). Added mktemp + jq validation of GET response (CORRECTNESS B1). Added `-f` to `_post_json` curl (STYLE W1). Removed fragile RETURN trap, added comment about explicit cleanup (STYLE W2). Sourced validators.sh and added `_validate_identifier` checks on PROJECT_ID/AGENT_NAME before injecting headers (SAFETY W1).
- **scripts/lib/validators.sh** -- Changed shebang to `#!/bin/bash` (STYLE B2). Added comment referencing `BRANCH_RE` in `server/src/branch-naming.ts` with exact character class match confirmed (STYLE W3).
- **scripts/lib/compose-detect.sh** -- Changed shebang to `#!/bin/bash` (STYLE B2).

## Design Decisions

- `_get_json` pipes through `jq '.'` which outputs the validated JSON to stdout, so the function still prints the response for callers.
- `_post_json` uses `jq -c '.'` to both validate and compact the JSON body before writing to tmpfile.
- Header validation failures are silent (stderr suppressed) -- the header is simply omitted rather than failing the request. This matches the original behavior of conditional inclusion.

## Build & Test Results

All four files pass `bash -n` syntax validation.

## Open Questions / Risks

- The `_status_color` rename in colors.sh means any future code sourcing this lib must use the new name. The original `status_color` in status.sh is not yet migrated.

## Suggested Follow-ups

- Phase 2+ should update status.sh to source colors.sh and use `_status_color`.
