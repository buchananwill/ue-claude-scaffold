# Debrief 0046 -- Phase 1 Review Findings (Cycle 2)

## Task Summary

Fix all WARNING-level review findings from cycle 2 reviewers (style, safety, correctness) against the shell script library files.

## Changes Made

- **scripts/lib/curl-json.sh** -- Added validated X-Project-Id and X-Agent-Name headers to `_get_json` using the same pattern as `_post_json`.
- **scripts/lib/curl-json.sh** -- Removed `2>/dev/null` from `_validate_identifier` calls in `_post_json` so invalid values produce visible stderr warnings.
- **scripts/lib/curl-json.sh** -- Changed `jq '.'` to `jq -c '.'` in `_get_json` for compact output consistent with `_post_json`.
- **scripts/lib/validators.sh** -- Added check rejecting branch names starting with `-` in `_validate_branch_name`.

## Design Decisions

- The `_get_json` headers array starts empty (no Content-Type needed for GET requests), unlike `_post_json` which starts with Content-Type.
- The leading-dash check in `_validate_branch_name` is placed before the `./` check since `-` is in the allowed character class and would otherwise pass all existing guards.

## Build & Test Results

All four lib files pass `bash -n` syntax validation.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
