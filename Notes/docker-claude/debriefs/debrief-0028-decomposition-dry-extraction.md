# Debrief 0028: Decomposition DRY Extraction

## Task Summary
Fix all decomposition review findings: DRY violations and file bloat across the multi-tenancy implementation. Seven fixes total: three BLOCKING (B1-B3) and four WARNING (W1-W3, W5).

## Changes Made

### B2: Export shared regexes from branch-naming.ts
- **server/src/branch-naming.ts** -- Exported `PROJECT_ID_RE`, `AGENT_NAME_RE`, and added `isValidProjectId()` / `isValidAgentName()` helper functions.
- **server/src/config.ts** -- Import `PROJECT_ID_RE` instead of local `projectIdPattern`.
- **server/src/queries/projects.ts** -- Re-export `isValidProjectId` from branch-naming instead of local `PROJECT_ID_PATTERN`.
- **server/src/plugins/project-id.ts** -- Import `PROJECT_ID_RE` instead of inline regex.
- **server/src/routes/build.ts** -- Import `AGENT_NAME_RE` instead of inline regex.
- **server/src/routes/tasks-claim.ts** -- Import `AGENT_NAME_RE` instead of inline regex.
- **server/src/routes/sync.ts** -- Import `AGENT_NAME_RE` instead of inline regex.
- **server/src/routes/tasks.ts** -- Import `AGENT_NAME_RE` instead of inline regex.
- **server/src/branch-naming.test.ts** -- Added tests for `isValidProjectId`, `isValidAgentName`, and the exported regex constants.

### B3: Extract resolveProject helper
- **server/src/routes/resolve-project.ts** -- New file. Canonical `resolveProject(config, db, projectId)` helper that encapsulates the DB lookup + config merge pattern.
- **server/src/routes/sync.ts** -- Uses `resolveProject` instead of manual DB lookup + `getProject`.
- **server/src/routes/tasks-claim.ts** -- Uses `resolveProject` instead of two separate try/catch blocks.
- **server/src/routes/tasks-files.ts** -- Uses `resolveProject` in `blockReasonsForTask`.
- **server/src/routes/tasks-lifecycle.ts** -- Uses `resolveProject` in task reset handler.
- **server/src/routes/tasks.ts** -- Uses `resolveProject` in POST /tasks, POST /tasks/batch, and PATCH /tasks/:id.
- **server/src/routes/agents.ts** -- Uses `resolveProject` in POST /agents/:name/sync.
- **server/src/routes/build.ts** -- Uses `resolveProject` in `resolveProjectForAgent`.

### B1: Extract shared build/test handler
- **server/src/routes/build.ts** -- Extracted `prepareBuildOrTest()` function that handles agent name validation, project resolution, UBT lock checking, worktree syncing, and staging plugins. Both `/build` and `/test` handlers now delegate their preamble to this shared function, eliminating ~35 lines of duplication.

### W1: Extract sourcePath validation
- **server/src/routes/tasks-validation.ts** -- New file. `validateSourcePath()` function encapsulating traversal check, bare-repo existence check, auto-sync fallback, and worktree fallback.
- **server/src/routes/tasks.ts** -- POST /tasks, POST /tasks/batch, and PATCH /tasks/:id now use `validateSourcePath` instead of inline validation blocks.

### W2: Extract targetAgents merge logic
- **server/src/git-utils.ts** -- Added `mergeIntoAgentBranches()` function that resolves agent names (including `'*'` expansion), iterates, and merges the seed branch into each agent branch.
- **server/src/routes/tasks.ts** -- POST /tasks targetAgents block uses `mergeIntoAgentBranches`.
- **server/src/routes/sync.ts** -- POST /sync/plans targetAgents block uses `mergeIntoAgentBranches`.

### W3: Extract project field validation
- **server/src/routes/projects.ts** -- Extracted `validateProjectFields()` function. Both POST /projects and PATCH /projects/:id use it instead of duplicated inline validation.

### W5: Extract _launch_container in launch.sh
- **launch.sh** -- Extracted `_launch_container()` shell function placed before team mode. All three launch paths (team member, parallel, single-agent) delegate to it.

## Design Decisions
- `resolveProject` is placed in `server/src/routes/resolve-project.ts` rather than `config.ts` to avoid a circular dependency (config.ts does not import from drizzle-instance or queries).
- `mergeIntoAgentBranches` is placed in `git-utils.ts` since it is a git operation helper, and it imports branch-naming + agents queries.
- The `validateSourcePath` function returns a discriminated union `{ valid: true } | { valid: false; message: string }` rather than throwing, matching the existing pattern where callers need to choose their error response type.
- For `_launch_container` in bash, the function uses `env` to pass env vars as arguments, allowing callers to specify arbitrary overrides.

## Build & Test Results
- **Typecheck**: `npx tsc --noEmit` -- PASS (clean, no errors)
- **Tests**: 487 passed, 0 failed, 0 skipped
- **Shell validation**: `bash -n launch.sh` -- PASS

## Open Questions / Risks
- The `_launch_container` function uses `env` command to pass overrides. This means the single-agent path now inherits all exported vars from the parent shell rather than only the explicitly listed ones. This matches existing behavior since those vars were already exported.

## Suggested Follow-ups
- The `tasks-lifecycle.ts` reset handler still has a sourcePath validation block that could also use `validateSourcePath`, but it has slightly different semantics (no auto-sync, check vs bare-repo or worktree). Could be unified with an additional option.
- The `health.ts` route also does a `projectsQ.getById` + `getProject` pattern that could use `resolveProject`, but it's in a different context (iterating all projects).
