---
title: "Audit and decompose oversized source files across the scaffold codebase"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: open
---

# Decompose bloated source files

## Problem

Several source files have grown into god files — too many responsibilities, too many lines. This makes them hard to review, hard for agents to work on concurrently (file ownership conflicts), and hard to reason about.

## Scope

Audit the entire scaffold codebase (`server/`, `dashboard/`, `container/`, `scripts/`) for oversized files. Any file over ~300 lines is a candidate for decomposition.

Known offenders (to be confirmed by audit):
- `server/src/routes/tasks.ts` — task CRUD, claiming, dependencies, replan, integration, file ownership, source path validation, bare repo git operations all in one file
- `server/src/routes/tasks.test.ts` — correspondingly massive test file

## Constraints

1. **Purely mechanical reorganisation.** Move functions, types, and route handlers into new files. No logic changes, no refactoring, no renaming.
2. **Non-regressive.** All existing tests must pass before and after. No test changes except import paths.
3. **Follow existing patterns.** Each route file exports a `FastifyPluginAsync` as default. Shared utilities go in dedicated modules (like `git-utils.ts`).
4. **If anything bloated remains after the split, that's a separate follow-up.** This issue is about file organisation, not code quality.

## Suggested decomposition (tasks.ts)

- `tasks.ts` — task CRUD (create, read, update, delete, batch)
- `tasks-claim.ts` — claim-next, claim, release
- `tasks-lifecycle.ts` — complete, fail, reset, integrate, integrate-batch, integrate-all
- `tasks-replan.ts` — replan endpoint, Kahn's algorithm, cycle detection, priority recomputation
- `tasks-git.ts` — bare repo git plumbing (writeContentToBareRepo, existsInBareRepo, isCommittedInRepo, mergeIntoBranch references)

The test file should mirror this structure.

## Process

1. Run full test suite — record baseline.
2. Identify all files over the threshold.
3. Decompose one at a time, re-running tests after each.
4. Final full test suite — confirm no regressions.
