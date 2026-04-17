---
name: style-sweep-protocol
description: Use when running a terminal style sweep as the last stage of a plan. Defines the edit-in-place loop — read diff, apply style fixes, build, test, commit, post. Compose with a domain style skill (ue-cpp-style, scaffold-server-patterns, react-component-discipline, etc.) plus container-git-write.
axis: process
---

# Style Sweep Protocol

The terminal style-sweep process. You are not a reviewer — you edit code directly. Your deliverable is a commit (or a `no-op` notice), not a findings report.

## Scope

### In-scope transformations

Applied per the rules of your loaded domain style skill:

- Local, member, and parameter renames for readability. Parameter renames must propagate across declaration, definition, and every call site.
- Magic literal hoisting to named constants.
- Dead code deletion (commented-out blocks, abandoned conditional-compilation blocks).
- Formatting, naming, and convention normalisation.
- Import / include hygiene adjustments.
- Explicit capture substitutions where greedy captures slipped through.

### Out-of-scope transformations

- Any change altering observable runtime behaviour.
- Any change to idioms the loaded domain style skill permits (e.g. UE's `if (!Ptr)` short-circuit nil check).
- Logic refactors, algorithmic changes, architectural restructuring.
- Adding or removing functions, classes, or types.

If a fix candidate requires a behavioural change to accomplish, skip it. Style sweeps never trade behaviour for cleanliness.

## Internal Loop

1. Read the git diff range supplied in the delegation prompt. Derive the full list of changed files.
2. Read each file in full. Apply style fixes in place per your loaded domain style skill.
3. Run the build. If it fails, read errors and fix. Maximum 3 build iterations.
4. Run tests. If tests fail, read output and fix. Maximum 3 test iterations.
5. If convergence is not reached within the combined budget, stop without committing and post `[STYLE SWEEP] failed` with the unstaged diff and failing output. The orchestrator surfaces this to the operator.
6. On clean build + clean tests, commit as a single commit with the message supplied in the delegation prompt (default format: `Style sweep: normalize <N> files post-plan`).

Build and test commands come from the environment skill you load alongside this one (e.g. `container-build-routing` + `project-test-knowledge` for UE, `scaffold-environment` + `scaffold-test-format` for TypeScript tracks). Use those commands directly — do not invent alternatives.

## No-op Case

If you read the changed files and determine nothing needs changing, post `[STYLE SWEEP] no-op` and exit without committing. A clean diff is a valid outcome.

## Output

Post to the message board as `[STYLE SWEEP]`:

- Files touched (count and full list).
- Category breakdown, e.g. `12 auto normalizations, 4 east-const, 3 magic-literal hoists, 2 IWYU adds, 1 dead-code removal`.
- Build outcome, test outcome.
- Commit hash.
- Duration in minutes.

## Critical Rules

- Behaviour-preserving only. If in doubt whether a change alters behaviour, skip it.
- One commit, all files. Do not split into multiple commits.
- Build and tests must be green before commit.
- Never revert work from prior phases under any circumstance.
- You are terminal — no reviewer runs after you. Your verification is the build + test green-light you performed internally.
