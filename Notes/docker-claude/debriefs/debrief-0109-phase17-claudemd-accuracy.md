# Debrief 0109 -- Phase 17: CLAUDE.md Documentation Accuracy

## Task Summary

Fix documentation inaccuracies in CLAUDE.md identified by all three Phase 17 reviewers. Four blocking issues (B1-B4) and three warning issues (W1-W3).

## Changes Made

- **File**: `CLAUDE.md`
  - **B1**: Removed `POST /agents/compile` from endpoint list (route does not exist; compilation is done by `scripts/lib/compile-agents.sh` calling `server/src/bin/compile-agent.ts`)
  - **B2**: Fixed `GET /hooks/{projectId}` to `POST /hooks/resolve` (stateless, body-driven endpoint)
  - **B3**: Fixed `GET /container-settings/{projectId}` to `GET /agents/:name/settings.json` and `GET /agents/:name/mcp.json`
  - **B4**: Replaced "thin dispatch layers (each <=200 lines)" with "focused dispatch scripts that delegate logic to shared libraries in `scripts/lib/`" (actual counts: launch.sh 144, setup.sh 262, status.sh 267, stop.sh 286)
  - **W1**: Added `scripts/launch-team.sh` to shell scripts command section and bash -n validation command
  - **W2**: No duplicate found -- "arg parsing" appears once in the parenthetical list, not alongside a separate `parse-launch-args.sh` mention. No change needed.
  - **W3**: Added network isolation note to coordination server description: "The server relies on network isolation and is not hardened for internet exposure"

## Design Decisions

- Cross-checked every endpoint in the CLAUDE.md list against actual route registrations in `server/src/routes/*.ts` to verify accuracy.
- W2 required no action as the described duplicate did not exist in the current text.

## Build & Test Results

- Server build: SUCCESS (`npm run build` in `server/`)
- No test changes needed (documentation-only change)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
