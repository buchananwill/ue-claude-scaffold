# Debrief 0169 -- execFileSync consistency in build.test.ts

## Task Summary
Fix 2 remaining safety warnings from review cycle 3 in `server/src/routes/build.test.ts`:
- W1: Replace 4 `execSync` template-string calls that interpolate `bareRepoDir` with `execFileSync`.
- W2: Replace 1 `execSync` template-string call that interpolates `OLD_FILE` with `execFileSync`.

## Changes Made
- **server/src/routes/build.test.ts** -- Replaced 5 `execSync` calls using template literals with `execFileSync('git', [...args], opts)`:
  1. `git clone "${bareRepoDir}" seed` (line ~479)
  2. `git push "${bareRepoDir}" docker/default/current-root` (line ~493)
  3. `git push "${bareRepoDir}" docker/default/test-agent` (line ~495, inside seedSetup)
  4. `git rm "${OLD_FILE}"` (line ~564)
  5. `git push "${bareRepoDir}" docker/default/test-agent` (line ~573, inside test body)

## Design Decisions
- `execFileSync` was already imported alongside `execSync` on line 6, so no import changes needed.
- Each replacement passes arguments as an array, eliminating shell interpolation of user-controlled paths.

## Build & Test Results
Pending initial build.

## Open Questions / Risks
None.

## Suggested Follow-ups
None -- this completes the safety review findings.
