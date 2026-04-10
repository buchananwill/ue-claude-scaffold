# Debrief 0156 -- Phase 12 Review Findings Fix

## Task Summary

Fix all review findings from Phase 12 schema hardening V2.5. Three reviewers returned REQUEST CHANGES with blocking and warning items across tasks.test.ts, build.test.ts, and coalesce.test.ts.

## Changes Made

- **server/src/routes/tasks.test.ts**
  - B1: Registered `agentsPlugin` in the first describe block's beforeEach and registered `agent-1`, `agent-lock`, `agent-resolver` agents so claim route calls succeed
  - B1: Added agent-1 registration in alpha/beta projects for the scoped deletion test
  - B1: Registered `agent-lock` and `agent-resolver` in the second describe block's beforeEach (they were used but not registered)
  - B2: Added `headers: { 'x-project-id': 'default' }` to all inject calls in the first describe block (used AST-aware brace parser to handle template literals safely)
  - B3: Added `'x-project-id': 'default'` to all inject calls in the second describe block
  - W3: Verified `sql` import is used in the file (in 6+ places in the second describe block)
  - W4: Added detailed comment at the direct DB write for sourcePath explaining it's intentional state-setup for an unreachable-via-API condition

- **server/src/routes/build.test.ts**
  - W1: Merged two `node:fs` imports into one: `import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'`

- **server/src/routes/coalesce.test.ts**
  - W2: Added `eq(files.projectId, 'default')` predicate alongside `eq(files.path, filePath)` in the claimTask helper's files update query, using `and()` to scope by project
  - W5: Added comment explaining the claimTask helper intentionally bypasses the claim route for state-setup purposes

## Design Decisions

- Used a purpose-built Node.js script with proper brace-counting that handles template literals (`${...}` expressions) to safely add headers to all inject calls without corrupting string content or payload objects.
- Registered all agents that could be referenced by tests (including `agent-lock` and `agent-resolver`) even though they're only used by specific tests, to avoid hidden failures.

## Build & Test Results

- Build: PASS (`npm run build`)
- build.test.ts: 17 pass, 0 fail
- coalesce.test.ts: 20 pass, 0 fail
- tasks.test.ts: 49 pass, 55 fail (all 55 failures are pre-existing -- caused by git identity configuration issue in the Docker container preventing bare repo setup in the second describe block. The first describe block improved from 44 pass to 49 pass)

## Open Questions / Risks

- The scoped deletion test (`scopes deletion to the requesting project`) was already failing before these changes. The failure is not caused by missing agent registration (which was added) but appears to be related to the task not being created in the alpha project. This warrants separate investigation.
- The 55 failures in the second describe block are all pre-existing, caused by `git commit-tree` failing with "Author identity unknown" in the Docker container. These tests require a bare git repo with commits.

## Suggested Follow-ups

- Fix git identity configuration in the container so the second describe block's bare repo tests can run.
- Investigate the scoped deletion test failure separately.
