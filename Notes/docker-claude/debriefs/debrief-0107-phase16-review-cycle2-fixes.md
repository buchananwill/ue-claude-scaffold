# Debrief 0107 -- Phase 16 Review Cycle 2 Fixes

## Task Summary
Fix five review warnings (W1-W5) in `container/Dockerfile` from Phase 16 cycle 2 review.

## Changes Made
- **container/Dockerfile** -- Modified:
  - W1+W2: Merged two consecutive `mkdir`/`chown` RUN layers into one, adding `/task` to the chown list
  - W3: Replaced `cd /mcp-servers && npm install` with `npm install --omit=dev --prefix /mcp-servers`
  - W4: Replaced `which python3` with `command -v python3` (POSIX built-in)
  - W5: Added `node --check /claude-hooks/lint-cpp-diff.mjs` to the smoke test for syntax verification

## Design Decisions
- Used `node --check` for the .mjs smoke test as it performs syntax checking without execution, which is the safest and most reliable approach for a Dockerfile build step.

## Build & Test Results
- Server build: SUCCESS
- entrypoint.sh syntax check: SUCCESS
- Tests: pending (running in background)

## Open Questions / Risks
- `node --check` behavior with ESM (.mjs) files -- the plan noted this should work but suggested a fallback if it doesn't. Since this runs during `docker build`, any failure would be caught at image build time.

## Suggested Follow-ups
None.
