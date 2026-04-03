# Debrief 0027 -- Phase 5 Review Cycle 2 Fixes

## Task Summary

Fix three review findings from Phase 5 documentation review cycle 2: inaccurate README config table description for `container.seedBranch`, misleading `.env.example` `WORK_BRANCH` default, and inconsistent heading levels in `container-git-write/SKILL.md`.

## Changes Made

- **README.md**: Fixed `container.seedBranch` description to remove incorrect claim that shell scripts read it. Added separate `tasks.seedBranch` row documenting the server-side usage.
- **.env.example**: Commented out `WORK_BRANCH=main` and added comments explaining it is normally computed by `launch.sh` and should only be set to override.
- **skills/container-git-write/SKILL.md**: Promoted top heading from `##` to `#` and all `###` subsection headings to `##`, matching the convention used by sibling skill files.

## Design Decisions

- For the SKILL.md heading fix, promoted the top-level heading to `#` (not just the subsections to `##`) to match the `#`/`##` pattern used by most sibling skill files like `container-git-build-intercept`, `container-git-readonly`, etc.

## Build & Test Results

- Server build: SUCCESS
- Server tests: pending (running in background)

## Open Questions / Risks

None.

## Suggested Follow-ups

- The `debrief-protocol/SKILL.md` and `orchestrator-phase-protocol/SKILL.md` files also use `##`/`###` patterns that may warrant similar heading promotion for consistency.
