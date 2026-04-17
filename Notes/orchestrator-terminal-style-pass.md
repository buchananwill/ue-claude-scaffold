# Orchestrator Terminal Style Pass

## Goal

Remove the style reviewer from the per-phase parallel review fan-out and replace it with a single terminal style pass. The new pass is a behaviour-preserving, edit-in-place Opus agent that runs once after all phases and the decomposition review, builds, runs tests, and commits as a single isolated work unit. Expected effect: fewer per-phase review cycles (style nits are the usual reason cycles hit the cap), lower total token spend, better final style consistency.

## Context

- Current style reviewer: `agents/container-style-reviewer.md`, model `haiku`, `disallowedTools: Write, Edit, NotebookEdit`. Returns findings to the orchestrator, which consolidates them with safety + correctness findings and sends the batch to the implementer (Opus) for fixes. Re-runs every review cycle until all three reviewers approve, up to 5 cycles.
- Protocol lives in two files that hold parallel content and must stay in sync:
  - `skills/orchestrator-phase-protocol/SKILL.md` — compiled into dynamic agents
  - `agents/container-orchestrator.md` — static agent definition
- Style pass must not fire if there are no changes to sweep — it must produce a no-op message and exit without committing.
- Build and tests are invoked through the existing PreToolUse intercept hook — the pass issues the same commands the implementer uses; the hook routes them to the host. No infrastructure change needed.
- Out of scope for this plan: changing the per-phase cycle cap, changing the severity gate (WARNINGs remain blocking), changing safety or correctness reviewer models.

## Phase 1 — Create `container-style-sweep` agent definition

**Outcome:** File `agents/container-style-sweep.md` exists with the frontmatter and prompt described below. Running `node ./scripts/validate-agents.mjs` (or whichever validator the scaffold uses) accepts the new file.

**Frontmatter:**

```yaml
---
name: container-style-sweep
description: Terminal style pass. Reads every file changed across the plan, normalizes style in place per `ue-cpp-style`, builds, runs tests, and commits once. Behaviour-preserving only.
model: opus
tools: Read, Edit, Write, Glob, Grep, Bash, Skill
---
```

Note the absence of a `disallowedTools` line — this agent edits.

**Prompt body requirements:**

- Load the `ue-cpp-style` skill first. It is the only source of truth for "correct style." Do not invent rules.
- In-scope transformations (all non-semantic):
  - `auto` normalization per the `ue-cpp-style` range-for rule and `auto const&` / `auto* const` patterns
  - East-const conversions (`const T&` → `T const&`)
  - Local, member, and parameter renames for readability (`x` → `NumGuests`). Parameter renames must propagate across the declaration, definition, and every call site.
  - Magic literal hoisting to a named constant (per the `ue-cpp-style` magic-literal rule)
  - Explicit lambda captures where greedy captures slipped through
  - IWYU additions and forward-declaration substitutions
  - Dead code deletion (commented-out blocks, abandoned `#if 0` blocks)
  - Brace-style normalization
- Out-of-scope transformations:
  - Any change altering observable runtime behaviour
  - `if (!Ptr)` → `if (Ptr == nullptr)` — `!Ptr` is idiomatic UE; leave untouched
  - Logic refactors, algorithmic changes, architectural restructuring
  - Adding or removing functions/classes/types
- Internal loop:
  1. Read the git diff range supplied in the delegation prompt. Derive the full list of files changed across all phases.
  2. Read each file in full. Apply style fixes in place.
  3. Run the project build command (supplied in the delegation prompt, matching `container-implementer`'s build command, currently `python Scripts/build.py --summary`). If it fails, read the errors and fix. Maximum 3 build iterations.
  4. Run the project test command (supplied in the delegation prompt). If tests fail, read the output and fix. Maximum 3 test iterations.
  5. If convergence is not reached within the combined budget, stop without committing and post `[STYLE SWEEP] failed` with the unstaged diff and the failing output. The orchestrator will surface this to the operator.
  6. On clean build and clean tests, commit as a single commit with the message `Style sweep: normalize <N> files post-plan`.
- No-op case: if after reading the files the agent determines nothing needs changing, post `[STYLE SWEEP] no-op` and exit without committing.
- Output posted to the message board as `[STYLE SWEEP]`:
  - Files touched (count and full list)
  - Category breakdown (e.g. `12 auto normalizations, 4 east-const, 3 magic-literal hoists, 2 IWYU adds, 1 dead-code removal`)
  - Build outcome, test outcome
  - Commit hash
  - Duration in minutes

**Work:**
- Write `agents/container-style-sweep.md` with the frontmatter above and a prompt body covering every requirement enumerated in this phase.
- Reference the `ue-cpp-style` skill by name; do not restate style rules in this file.
- Reference the existing build/test commands as "supplied by the orchestrator in the delegation prompt," not hardcoded, so future command changes do not require editing the agent.

**Verification:**
- `node ./scripts/validate-agents.mjs` (or the project's equivalent) passes.
- Manual read-through confirms the in-scope / out-of-scope lists match this plan verbatim.
- `grep -r 'container-style-sweep' agents/` returns the new file.

## Phase 2 — Update the orchestrator protocol (skill and static agent in sync)

**Outcome:** Both `skills/orchestrator-phase-protocol/SKILL.md` and `agents/container-orchestrator.md` describe a per-phase review loop with only two reviewers (safety + correctness) in the parallel fan-out, and a new Final Stage — Style Sweep after the decomposition review.

**Files to edit:**
- `D:/coding/ue-claude-scaffold/skills/orchestrator-phase-protocol/SKILL.md`
- `D:/coding/ue-claude-scaffold/agents/container-orchestrator.md`

**Per-phase review changes (apply to both files):**

- Step 2 parallel fan-out drops `style-reviewer`. Remaining reviewers: `safety-reviewer`, `reviewer` (correctness).
- Step 2 scope-selection rule drops the specific mention of the style reviewer. Keep the general "match reviewers to the nature of the changed files" guidance.
- Step 2a consolidation still batches all findings from the remaining reviewers. The "unambiguous style fixes in touched files" instruction to the implementer **stays** — implementer continues to fix drive-by style as it goes; the style sweep catches what slipped.
- Step 2c posting drops the `[STYLE REVIEW]` tag. Two reviewer tags remain: `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`.
- Decomposition Re-review (Decomp Step 4) drops `style-reviewer`. Remaining reviewers in that pass: safety + correctness.
- Agent Resolution table / reviewer list removes `style-reviewer` and its row. Add `style-sweep` as a new row mapped to `container-style-sweep`.

**New Final Stage — Style Sweep (insert after decomposition review, before Final Output, in both files):**

```
## Final Stage — Style Sweep

After the decomposition review and its re-review pass have completed successfully, run a single terminal style pass. This is the last code-modifying stage before Final Output.

### Style Step 1 — Collect changed files

Produce the full list of files changed across all phases including decomposition. Use `git diff <branch-base>..HEAD --name-only`. Keep the list scoped to the project's source extensions (`.h`, `.cpp`, and any other extensions the project's style skill covers).

### Style Step 2 — Delegate

Post `style_sweep_start` to `general`. Delegate to **style-sweep** with:
- The `git diff` range the pass should inspect (`<branch-base>..HEAD`)
- The full list of changed files
- The project build command (e.g. `python Scripts/build.py --summary`)
- The project test command

### Style Step 3 — Post result

Post the agent's `[STYLE SWEEP]` output to `general`. Three possible terminal states:
- `no-op` — nothing was changed. Proceed to Final Output.
- Clean sweep with a commit — verify `git status` is clean and the new commit exists. Proceed to Final Output.
- `failed` — the sweep could not converge. Post `phase_failed` with the reason and stop. Operator input required.

The style sweep is **not re-reviewed**. It is terminal by design. Its verification is the build and test green-light it performs internally.
```

**Final Output template update (both files):**

- Remove the `Style Review` line from the per-phase block.
- Add a `Final Style Sweep` block after `Decomposition Review`:
  ```
  ### Final Style Sweep
  - Verdict: APPROVE (N files normalized, commit <hash>) / NO-OP / FAILED
  - Build: PASS/FAIL
  - Tests: PASS/FAIL
  ```

**Work:**
- Edit both files with the changes above. Keep per-phase block identical across files; they document the same protocol.
- Do not change the cycle budget (5), the WARNING-blocking policy, or the consolidation pattern.
- Do not change any language about the implementer's inline style rule.

**Verification:**
- `grep -n 'style-reviewer' skills/orchestrator-phase-protocol/SKILL.md agents/container-orchestrator.md` returns zero hits (should be fully replaced by `style-sweep` references where the new agent is referenced, or removed entirely from the per-phase fan-out).
- `grep -n 'STYLE REVIEW' skills/orchestrator-phase-protocol/SKILL.md agents/container-orchestrator.md` returns zero hits.
- `grep -n 'STYLE SWEEP' skills/orchestrator-phase-protocol/SKILL.md agents/container-orchestrator.md` returns multiple hits in both files.
- Diff both files against HEAD to confirm structural parity.

## Phase 3 — Retire the old style reviewer

**Outcome:** `agents/container-style-reviewer.md` is deleted. No remaining reference to `container-style-reviewer` exists anywhere in `agents/`, `skills/`, `dynamic-agents/`, `scripts/`, `container/`, `server/`, or `dashboard/` source.

**Work:**
- Delete `D:/coding/ue-claude-scaffold/agents/container-style-reviewer.md`.
- `grep -rn 'container-style-reviewer' D:/coding/ue-claude-scaffold` — for every hit:
  - If the reference is a reviewer-list enumeration, replace with `container-style-sweep` if context makes sense, or delete the line if the reference was per-phase-style-reviewer-specific.
  - If the reference is documentation describing the old flow, update the documentation to describe the new flow.
  - If the reference is a test fixture or config, update or delete as appropriate.
- Check `CLAUDE.md` — the agent-type bullet list includes `container-style-reviewer`. Replace with `container-style-sweep` and update the one-line description to reflect the terminal edit-in-place behaviour.

**Verification:**
- `grep -rn 'container-style-reviewer' D:/coding/ue-claude-scaffold` returns zero hits.
- `grep -rn 'container-style-sweep' D:/coding/ue-claude-scaffold` returns hits in at least: the new agent file, both protocol files, `CLAUDE.md`.
- The scaffold server tests pass (`npm test` in `server/`).

## Phase 4 — End-to-end smoke test

**Outcome:** A real container run against a small multi-phase plan completes successfully with the new protocol. Per-phase review cycles use only safety + correctness. The terminal style sweep runs, commits a single normalization commit (or posts `no-op`), and the Final Summary reflects the new section.

**Work:**
- Pick or author a small 2-phase plan in the target UE project (PistePerfect) — something with enough code change to produce real style drift. A no-op phase does not exercise the sweep meaningfully.
- Launch a container: `./launch.sh --fresh` with the chosen plan.
- While it runs, monitor `./status.sh --follow` and the dashboard's message stream.
- After completion, verify from the dashboard and the target branch:
  - Per-phase messages include `[SAFETY REVIEW]` and `[CORRECTNESS REVIEW]` but not `[STYLE REVIEW]`.
  - A single `[STYLE SWEEP]` message exists after the decomposition review completes.
  - If the sweep made changes, exactly one commit titled `Style sweep: normalize <N> files post-plan` exists on the agent branch after all phase commits and the decomposition commit.
  - The Final Summary message contains a `Final Style Sweep` section.
  - Build and test status for the sweep commit are both PASS.

**Verification:**
- Dashboard timeline for the run matches the expected message sequence above.
- `git log docker/<project-id>/<agent>` on the bare repo shows the expected commit ordering.
- If the sweep failed, the test is failed — investigate and iterate on the agent prompt before calling this phase done.

Plan saved to [Notes/orchestrator-terminal-style-pass.md](./Notes/orchestrator-terminal-style-pass.md). Read and fire back edits.
