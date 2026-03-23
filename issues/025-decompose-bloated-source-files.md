---
title: "Audit and decompose oversized source files across the scaffold codebase"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Decompose bloated source files

## Problem

Several source files have grown into god files — too many responsibilities, too many lines. This makes them hard to
review, hard for agents to work on concurrently (file ownership conflicts), and hard to reason about.

## Scope

Audit the entire scaffold codebase (`server/`, `dashboard/`, `container/`, `scripts/`) for oversized files. Any file
over ~300 lines is a candidate for decomposition.

Known offenders (to be confirmed by audit):

- `server/src/routes/tasks.ts` — task CRUD, claiming, dependencies, replan, integration, file ownership, source path
  validation, bare repo git operations all in one file
- `server/src/routes/tasks.test.ts` — correspondingly massive test file

## Constraints

1. **Purely mechanical reorganisation.** Move functions, types, and route handlers into new files. No logic changes, no
   refactoring, no renaming.
2. **Non-regressive.** All existing tests must pass before and after. No test changes except import paths.
3. **Follow existing patterns.** Each route file exports a `FastifyPluginAsync` as default. Shared utilities go in
   dedicated modules (like `git-utils.ts`).
4. **If anything bloated remains after the split, that's a separate follow-up.** This issue is about file organisation,
   not code quality.

## Suggested decomposition (tasks.ts)

- `tasks.ts` — task CRUD (create, read, update, delete, batch)
- `tasks-claim.ts` — claim-next, claim, release
- `tasks-lifecycle.ts` — complete, fail, reset, integrate, integrate-batch, integrate-all
- `tasks-replan.ts` — replan endpoint, Kahn's algorithm, cycle detection, priority recomputation
- `tasks-git.ts` — bare repo git plumbing (writeContentToBareRepo, existsInBareRepo, isCommittedInRepo, mergeIntoBranch
  references)

The test file should mirror this structure.

## Audit Results (2026-03-23)

### Tier 1 — Critical (>500 lines, multiple distinct responsibilities)

| File                              | Lines | Responsibilities                                  |
|-----------------------------------|-------|---------------------------------------------------|
| `server/src/routes/tasks.ts`      | 1625  | 7 responsibility groups (see decomposition below) |
| `server/src/routes/tasks.test.ts` | 3729  | Mirrors tasks.ts — split should follow source     |

### Tier 2 — Moderate (300–600 lines, could benefit from split)

| File                                         | Lines | Assessment                                                                                                                                                                                                                                     |
|----------------------------------------------|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `server/src/routes/build.test.ts`            | 581   | 3 test suites (basic, branch resolution, UBT contention). Could split by suite but not urgent — each suite is cohesive.                                                                                                                        |
| `server/src/routes/agents.test.ts`           | 498   | Single-concern test file. Borderline — leave for now.                                                                                                                                                                                          |
| `dashboard/src/hooks/useTaskFilters.test.ts` | 486   | Single-concern test file. Leave.                                                                                                                                                                                                               |
| `dashboard/src/components/TasksPanel.tsx`    | 472   | Table rendering + filter UI + action handlers + sort headers + bulk delete. See dashboard decomposition below.                                                                                                                                 |
| `server/src/routes/messages.test.ts`         | 443   | Single-concern test file. Leave.                                                                                                                                                                                                               |
| `container/entrypoint.sh`                    | 392   | Sequential script: clone, setup, register, poll loop, prompt assembly, Claude invocation. Linear flow — splitting would hurt readability. Leave.                                                                                               |
| `server/src/routes/build.ts`                 | 370   | `syncWorktree` (90 lines) + `runCommand` (30 lines) + two route handlers. Marginally over threshold; `syncWorktree` could extract to a utility but the coupling to `getStagingWorktree` and `getBareRepoPath` makes it awkward. Leave for now. |
| `launch.sh`                                  | 350   | Mostly argument parsing + config loading. Linear flow. Leave.                                                                                                                                                                                  |
| `server/src/routes/ubt.test.ts`              | 341   | Single-concern test file. Leave.                                                                                                                                                                                                               |
| `server/src/routes/ownership.test.ts`        | 301   | At threshold. Leave.                                                                                                                                                                                                                           |

### Tier 3 — Under threshold (<300 lines)

All remaining files. No action needed.

---

### Detailed decomposition: `server/src/routes/tasks.ts` (1625 lines)

The file contains 7 distinct responsibility groups. Line ranges and proposed file targets:

#### 1. `tasks-git.ts` — bare repo git plumbing (lines 56–207, ~150 lines)

- `isCommittedInRepo()` — checks if a file is tracked in HEAD
- `existsInBareRepo()` — checks if a file exists on a branch in a bare repo
- `writeContentToBareRepo()` — writes a file to a bare repo via git plumbing (hash-object, mktree, commit-tree,
  update-ref)
- `buildTreeWithFile()` — recursive tree builder for nested paths
- All pure functions, no Fastify or DB dependency. Already analogous to `git-utils.ts` (which has `mergeIntoBranch`).
  Could merge into `git-utils.ts` or be a separate `tasks-git.ts`.

**Recommendation:** Merge into existing `git-utils.ts` (currently 67 lines → ~217 lines, well under threshold).

#### 2. `tasks-types.ts` — shared types and formatters (lines 8–49, ~40 lines)

- `TaskRow` interface
- `formatTask()` function
- Used by every other tasks-* module

**Recommendation:** New file. Small but eliminates circular imports between split modules.

#### 3. `tasks-files.ts` — file ownership and validation helpers (lines 209–487, ~280 lines)

- `ConflictInfo` interface, `TasksOpts`, `TaskBody`, `PatchBody` types
- All prepared statements for file ownership (`insertFile`, `insertTaskFile`, `getTaskFiles`, `claimFilesForAgent`,
  `getFileConflicts`, etc.)
- All prepared statements for dependencies (`insertDep`, `getDepsForTask`, `getIncompleteBlockersForTask`, etc.)
- Helper functions: `checkAndClaimFiles()`, `filesForTask()`, `blockReasonsForTask()`, `formatTaskWithFiles()`,
  `linkFilesToTask()`, `linkDepsToTask()`, `validateFilePaths()`, `unknownFields()`
- These are shared internals used by CRUD, claim, and lifecycle routes.

**Recommendation:** New file. This is the shared "data access layer" for the tasks subsystem. All other tasks-* route
files import from here. The prepared statements are initialized inside the Fastify plugin closure, so this would need to
be a factory function or module-level init pattern (like `ubt.ts` uses `initUbtStatements()`).

#### 4. `tasks.ts` — CRUD routes (lines 490–863, ~370 lines) — stays in `tasks.ts`

- `POST /tasks` — create (with sourcePath validation, sourceContent git write, targetAgents merge)
- `POST /tasks/batch` — bulk create
- `GET /tasks` — list with filtering
- `GET /tasks/:id` — get single
- `PATCH /tasks/:id` — edit pending task
- `DELETE /tasks/:id` — delete single
- `DELETE /tasks` — bulk delete by status

This is the core CRUD and should remain as the main `tasks.ts` plugin.

#### 5. `tasks-claim.ts` — claim routes (lines 1118–1395, ~280 lines)

- `POST /tasks/claim-next` — atomically find and claim best task (complex SQL + sourcePath validation + file claiming)
- `POST /tasks/:id/claim` — claim specific task
- `POST /tasks/:id/release` — release a claimed task
- `POST /tasks/:id/update` — progress update
- `validateSourcePathForClaim()` helper
- All the `claimNextCandidate`, `countPending`, `countBlocked`, `countDepBlocked` prepared statements

**Recommendation:** New Fastify plugin file. These are the agent-facing "work dispatch" routes. High concurrent-access
complexity.

#### 6. `tasks-lifecycle.ts` — completion and integration routes (lines 1354–1607, ~250 lines)

- `POST /tasks/:id/complete`
- `POST /tasks/:id/fail`
- `POST /tasks/:id/reset`
- `POST /tasks/:id/integrate`
- `POST /tasks/integrate-batch`
- `POST /tasks/integrate-all`

**Recommendation:** New Fastify plugin file. Simple state-machine transitions, low complexity.

#### 7. `tasks-replan.ts` — replan logic (lines 919–1104, ~185 lines)

- `runReplan()` — Kahn's topological sort, Tarjan's SCC for cycle detection, priority recomputation
- `POST /tasks/replan` — endpoint wrapper
- Prepared statements: `getNonTerminalTasksForReplan`, `getNonTerminalDepsForReplan`, `markTaskCycle`, `setTaskPriority`

**Recommendation:** New file. Self-contained algorithm with no shared state except DB access.

---

### Detailed decomposition: `dashboard/src/components/TasksPanel.tsx` (472 lines)

Three extractable pieces:

1. **`SortHeader` component** (lines 51–79, 30 lines) — generic reusable column sort header. Extract to
   `SortHeader.tsx`.
2. **`TaskRowActions`** — inline action handlers (`handleRelease`, `handleDelete`, `handleBulkDelete`, `handleReset`,
   `handleReplan`) are defined inside the component body. Extract to a `useTaskActions.ts` hook that returns
   `{ release, delete, bulkDelete, reset, replan }`.
3. **Expanded row detail** — the `Collapse` block rendering dependencies, files, progress log, and result JSON is ~100
   lines of JSX. Extract to `TaskDetailRow.tsx`.

After extraction, `TasksPanel.tsx` would be ~250 lines: the table structure, column headers, and row iteration.

---

### Implementation order

1. `tasks-git.ts` (or merge into `git-utils.ts`) — zero coupling, pure functions, simplest extraction.
2. `tasks-types.ts` — shared types needed by all other splits.
3. `tasks-files.ts` — shared data-access layer. Requires designing the init pattern (factory or module-level
   statements).
4. `tasks-replan.ts` — self-contained algorithm.
5. `tasks-claim.ts` — claim dispatch routes.
6. `tasks-lifecycle.ts` — lifecycle state transitions.
7. `tasks.ts` — what remains: CRUD routes, Fastify plugin export, registers sub-plugins.
8. `tasks.test.ts` — split to mirror source structure.
9. `TasksPanel.tsx` — dashboard extractions (lower priority, less impact).

## Process

1. Run full test suite — record baseline.
2. Identify all files over the threshold.
3. Decompose one at a time, re-running tests after each.
4. Final full test suite — confirm no regressions.
