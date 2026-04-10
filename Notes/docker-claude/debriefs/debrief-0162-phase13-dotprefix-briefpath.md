# Debrief 0162 -- Phase 13: Reject dot-prefixed segments in briefPath

## Task Summary
Fix W1 review finding: briefPath validation allowed dot-prefixed segments like `.git`, `.env`, `.hidden`. Both validation blocks in teams.ts needed updating.

## Changes Made
- **server/src/routes/teams.ts**: Changed both briefPath segment checks from `s === '.' || s === '..'` to `s.startsWith('.')`. Updated error messages to "briefPath must not contain dot-prefixed segments".
- **server/src/routes/teams.test.ts**: Updated the path-traversal test assertion from checking for `..` to checking for `dot-prefixed` in the error message.

## Design Decisions
- The `s.startsWith('.')` check subsumes the previous `.` and `..` checks while also covering `.git`, `.env`, `.hidden`, etc.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 27 passed, 0 failed (`teams.test.ts`)

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
