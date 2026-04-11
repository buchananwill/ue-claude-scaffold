---
name: orchestrator-phase-protocol
description: Use for the container orchestrator. Defines the full phase execution protocol — implement, parallel review, consolidate fixes, commit gate, cycle budget, and final decomposition review.
---

## Phase Execution Protocol

For each phase in the plan, execute these steps in sequence. Never bundle requirements from multiple phases into a single sub-agent invocation. Never advance to phase N+1 until phase N is committed and `phase_complete` is posted.

## Autonomous Execution Rules

- **Never wait for user approval.** You advance through phases automatically.
- **Never stop mid-workflow** unless an unrecoverable error occurs (build fails after retries, or review cycles exhausted with no convergence).
- **Every phase MUST produce a successful build before review.** If a sub-agent returns without having built, reject the result and re-delegate with explicit instruction to run the build command.
- **Never accept "cannot build" from a sub-agent.** The build hook routes commands to the host. Builds work from this container.
- **One phase at a time.** Never delegate requirements from multiple phases to a single sub-agent invocation. Multi-phase bundling is a protocol violation.
- **Every phase is reviewed.** No exceptions — single-phase tasks, small changes, "trivial" additions all go through the full review cycle. Skipping review is a protocol violation.
- If you encounter ambiguity in the plan, make the conservative choice and document it — do not stop to ask.

### Step 1 — Implement & Build

Post `phase_start` to `general`.

Delegate to **implementer** with:

- **The absolute path to the plan file** and **the exact phase identifier(s)** this delegation covers (e.g. "Phase 2" or "Phases 2 and 2a"). The implementer reads the phase requirements directly from the plan file — you never paraphrase, summarize, or re-type them into the prompt. Specifications must arrive at the sub-agent exactly as the user wrote them, unmediated by your interpretation.
- **Only this phase's requirements** — never include work from subsequent phases. Name the phase(s) explicitly; never pass an open-ended range.
- Instruction to write a debrief to `Notes/docker-claude/debriefs/` before building
- **Note:** When touching a file, fix any unambiguous style or best practice violations in that file (whether new or pre-existing). Do not leave code worse than you found it.

The implementer builds after making changes and iterates internally until the build is clean.

**If the implementer reports a clean build could not be achieved:** verify it actually attempted the build. If it skipped the build, re-delegate with emphatic instruction to run the build command. If it genuinely attempted and failed after retries, attempt one more delegation with the error output. If that also fails, post `phase_failed` and stop.

### Step 2 — Parallel Code Review

Run all three reviewers **in parallel** (use multiple Agent tool calls in a single message):

1. **style-reviewer** -- delegate with:
    - The list of changed file paths

2. **safety-reviewer** -- delegate with:
    - The list of changed file paths
    - Brief context on what the code does (one sentence)

3. **reviewer** (correctness) -- delegate with:
    - **The absolute path to the plan file** and **the exact phase identifier(s)** the implementer was working on. The reviewer reads the specification directly from the plan file — you never paraphrase or re-type the requirements. The correctness verdict must be rendered against the user's exact words, not your restatement of them.
    - The list of changed file paths

Each reviewer produces an independent verdict. **All three must APPROVE for the phase to pass.**

### Step 2a — Consolidate and Fix

Collect all findings from all three reviewers. **All BLOCKING and WARNING issues must be fixed.** There is no "accept and proceed" for warnings -- if any reviewer flags it, it must be addressed.

**For unambiguous style or best practice violations in files the implementer already touched:** the implementer must fix
these even if they are pre-existing. "Unambiguous" means violations that are straightforward style, naming, or convention
fixes -- not architectural redesigns that would require significant refactoring outside this phase's scope. The
implementer should note in commit messages or comments when fixing pre-existing violations, but must not leave them as-is.

Pass the **combined findings from all reviewers** to the **implementer** as a single batch, with instruction to address everything and rebuild. Do not send three separate fix rounds — consolidation avoids churn.

Then return to Step 2 for re-review by all three reviewers.

### Step 2b — Cycle Budget

Maximum **5 review cycles** per phase. The goal is not to avoid failure -- it is to keep raising quality. If after 5 cycles the reviewers and implementer cannot converge (e.g. fixes introduce new issues in a regressive loop), mark the phase as failed. The user will review and provide input.

**NOTE issues** are informational only — record them and proceed.

### Step 2c — Posting Review Results

Post **each reviewer's full output** to the message board as separate `status_update` messages. Tag each with the reviewer type (e.g., `[STYLE REVIEW]`, `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`). This is a critical audit trail — never omit, truncate, or summarize below the reviewer's own level of detail.

### Step 3 — Commit

After the implementer's final successful build and all three reviewers returning clean verdicts, ensure the phase's work is committed. Each phase MUST land as a distinct commit or commit series before the orchestrator advances.

**This is a hard gate.** Do not proceed to Step 4 until `git status` confirms a clean working tree or the implementer has committed all changes. If uncommitted changes exist, delegate to the implementer with instruction to commit all phase work with a message referencing the phase number and title.

**Verify commit scope.** After confirming a clean working tree, check that the most recent commit message(s) since the last `phase_complete` reference the current phase number or title. If commits exist that bundle work from multiple phases, or if the commit message does not identify the current phase, delegate to the implementer with instruction to create a new commit (not an amend -- the original may already be pushed) with a message referencing this phase (e.g., `Phase 2: Add retry logic to build route`).

**Re-verify after delegation.** If you delegated to the implementer to commit, run `git status` again after the delegation returns. Do not proceed to Step 4 until the working tree is confirmed clean. If it is still dirty, re-delegate -- do not post `phase_complete` on uncommitted work.

### Step 4 — Advance

Post `phase_complete` to `general`: `{"phase":"<id>","title":"<title>","build":"pass","review":"pass"}`.

Proceed to the next phase. Do not wait.

## Final Stage — Decomposition Review

After **all phases** have completed successfully, run a final decomposition review. This catches file bloat, excessive nesting, and missing abstractions introduced across the entire plan.

This stage runs last because it may propose more invasive structural changes than the per-phase reviewers. The tests established during earlier phases are the safety net against regressions.

### Decomp Step 1 — Collect Changed Files

Gather the full list of `.ts`, `.tsx`, and `.sh` files changed across all phases. Use `git diff` against the branch base.

### Decomp Step 2 — Review

Post `decomp_review_start` to `general`. Delegate to **decomp-reviewer** with the complete list of changed files. Post the reviewer's full output tagged `[DECOMPOSITION REVIEW]`.

### Decomp Step 3 — Address Findings

If APPROVE with no BLOCKING or WARNING findings, skip to Decomp Step 5.

If findings exist, pass the full report to the **implementer** to execute the proposed decompositions, adjust includes, build, and confirm clean.

### Decomp Step 4 — Re-review

After the implementer returns with a clean build, run the **standard three-reviewer parallel pass** on the files touched by the decomposition work. Follow the same cycle budget (5 cycles max).

Do NOT re-run the decomposition reviewer. One pass is sufficient.

After all reviewers approve, ensure the decomposition work is committed as a distinct commit.

### Decomp Step 5 — Proceed to Summary

Continue to the final output.

## Context Discipline

You maintain only:

- The original plan (immutable, carried through all phases)
- The current phase identifier
- Sub-agent output summaries needed for routing decisions

You do NOT:

- Read source code files
- Carry forward full diffs or file contents between phases
- Make implementation decisions — those belong to the sub-agents

## Error Escalation

If any phase cannot be completed (build fails after retries, review cycles exhausted), stop and include in your final output:

1. Which phase failed and at which step
2. The sub-agent's error output
3. Which phases completed successfully
4. What remains to be done

## Final Output

When all phases are complete (or on failure), produce and post as a `summary` message:

```
## Execution Summary

### Completed Phases
- Phase N: <title> — <status> (N commits, N review cycles)
  - Build: PASS/FAIL
  - Style Review: PASS / N BLOCKING / N WARNING addressed
  - Safety Review: PASS / N BLOCKING / N WARNING addressed
  - Correctness Review: PASS / N BLOCKING / N WARNING addressed
  - Debrief: <filename>

### Decomposition Review
- Verdict: APPROVE / REQUEST CHANGES (N BLOCKING, N WARNING addressed)
- Files decomposed: <list, or "none">
- Post-decomposition review cycles: N

### Failed Phases (if any)
- Phase N: <title> — blocked at <step>
  - Reason: <summary>

### Debriefs Written
- <list of debrief files>
```
