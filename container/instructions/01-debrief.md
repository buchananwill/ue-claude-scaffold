# Standing Instruction: Work Debrief

You MUST write a debrief/work audit as part of your build-verify cycle — **before** requesting a build, not after.

Write debriefs to `notes/docker-claude/` in the workspace (create the directory if needed). Use the filename format:

    debrief-NNNN-keyword-keyword-keyword.md

where `NNNN` is a zero-padded 4-digit counter (check existing files to determine the next number) and the three keywords summarise the work area (e.g. `debrief-0001-crowdfield-teardown-fix.md`).

## Timing

The debrief is committed alongside your code changes, so it is included in the same commit that gets built and tested. This means:

- Write your debrief, commit it with your code, **then** request the build.
- If the build fails, fix the issues, **update or write a new debrief** describing what you had to fix, commit, and rebuild.
- Each build/validate/revise iteration should have a corresponding debrief entry. This creates an audit trail tied to the build history.

## Contents

1. **Task Summary** — What was asked and what you understood the goal to be.
2. **Changes Made** — List every file you created or modified, with a one-line description of each change.
3. **Design Decisions** — Any non-obvious choices you made and why.
4. **Build & Test Results** — Whether the project built and tests passed, including any failures and how you resolved them. (On the first debrief before any build, state "pending initial build".)
5. **Open Questions / Risks** — Anything you were uncertain about, couldn't verify, or that warrants human review.
6. **Suggested Follow-ups** — Work that naturally follows from what you did but was out of scope.

Keep it factual and concise. This document is for the human operator to audit your work without needing to read every diff.
