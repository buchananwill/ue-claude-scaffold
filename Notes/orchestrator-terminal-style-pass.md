# Orchestrator Terminal Style Pass

## Goal

Remove the style reviewer from the per-phase parallel review fan-out in the three orchestrator families whose style axis is purely presentation, and replace it with a single terminal style pass per plan. The new pass is a behaviour-preserving, edit-in-place Opus agent that runs once after all phases and the decomposition review, builds, runs tests, and commits as a single isolated work unit. Expected effect across those tracks: fewer per-phase review cycles (style nits are the usual reason cycles hit the cap), lower total token spend, better final style consistency. The two dashboard orchestrators are explicitly out of scope — their "style" slot is filled by a React quality reviewer whose findings (hook/component layering, dependency-array discipline) can be behaviour-changing and therefore belong in the per-phase review loop, not a terminal sweep.

## Context

**Orchestrator families in scope** — the three orchestrators whose style slot is filled by a pure-presentation reviewer. Each consumes the shared `orchestrator-phase-protocol` skill plus a track-specific wiring skill.

| Orchestrator | Wiring skill | Track | Current style reviewer |
|---|---|---|---|
| `container-orchestrator-ue` | `orchestrator-system-wiring` | UE C++ | `container-style-reviewer-ue` |
| `scaffold-orchestrator` | `scaffold-system-wiring` | scaffold root (TS) | `scaffold-style-reviewer` |
| `scaffold-server-orchestrator` | `scaffold-server-system-wiring` | `server/` | `scaffold-server-style-reviewer` |

**Orchestrator families explicitly out of scope** — the two dashboard orchestrators. Their style slot is filled by `scaffold-dashboard-react-quality-reviewer`, which includes component discipline (hook/component split, finger rule, layered architecture) and dependency-array auditing. Those findings can be behaviour-changing (a trimmed dependency array can eliminate a stale-closure bug; a hook/component split can change call-site semantics) and belong in the per-phase review loop, not a terminal sweep. These orchestrators keep their current protocol unchanged.

| Orchestrator | Wiring skill | Track | Current style reviewer | Disposition |
|---|---|---|---|---|
| `scaffold-dashboard-orchestrator` | `scaffold-dashboard-system-wiring` | `dashboard/` | `scaffold-dashboard-react-quality-reviewer` | Unchanged |
| `content-catalogue-dashboard-orchestrator` | `content-catalogue-dashboard-system-wiring` | content-catalogue SPA | `scaffold-dashboard-react-quality-reviewer` (shared) | Unchanged |

- The phase protocol itself is canonicalised in `skills/orchestrator-phase-protocol/SKILL.md`. All five orchestrators load it; its revision must therefore make the per-phase style slot and the terminal sweep both **opt-in per wiring**, so in-scope wirings adopt the sweep while out-of-scope wirings keep their per-phase reviewer.
- The old static UE orchestrator at `agents/container-orchestrator.md` is deprecated and out of scope here (tracked under issue 047).
- All current style reviewers run on `sonnet`, are read-only, and return findings to the orchestrator to be consolidated with safety + correctness findings. Re-runs every review cycle, up to 5 cycles.
- Dynamic agents are recompiled automatically from skill and agent sources — no manual compile step needed.
- Style pass must not commit if nothing is changed — produce a no-op message and exit.
- Build and test commands for the sweep are supplied per-delegation from the orchestrator's wiring skill, not hardcoded in the sweep agent.
- Out of scope: changing the per-phase cycle cap (5), changing the severity gate (WARNINGs remain blocking), changing safety / correctness reviewer models, editing `agents/container-orchestrator.md`, editing the two dashboard wirings or their React quality reviewer.

## Phase 1 — Add shared `style-sweep-protocol` skill

**Outcome:** A new skill at `skills/style-sweep-protocol/SKILL.md` exists. It defines the domain-agnostic terminal style-pass loop: read diff, apply edits, build, test, commit, post. It is the action-oriented counterpart to `review-process` and is loaded by every style-sweep dynamic agent created in Phase 2.

**File to create:**

- `D:/coding/ue-claude-scaffold/skills/style-sweep-protocol/SKILL.md`

**Frontmatter:**

```yaml
---
name: style-sweep-protocol
description: Use when running a terminal style sweep as the last stage of a plan. Defines the edit-in-place loop — read diff, apply style fixes, build, test, commit, post. Compose with a domain style skill (ue-cpp-style, scaffold-server-patterns, react-component-discipline, etc.) plus container-git-write.
axis: process
---
```

**Required body sections:**

- **In-scope transformations** — domain-agnostic framing; specific rules come from the loaded domain style skill:
    - Local, member, and parameter renames for readability. Parameter renames must propagate across declaration, definition, and every call site.
    - Magic literal hoisting to named constants
    - Dead code deletion (commented-out blocks, abandoned conditional-compilation blocks)
    - Formatting, naming, and convention normalisation as defined by the loaded domain style skill
    - Import / include hygiene adjustments
    - Explicit capture substitutions where greedy captures slipped through
- **Out-of-scope transformations:**
    - Any change altering observable runtime behaviour
    - Any change to idioms the loaded domain style skill permits (e.g. UE's `if (!Ptr)`)
    - Logic refactors, algorithmic changes, architectural restructuring
    - Adding or removing functions, classes, or types
- **Internal loop:**
    1. Read the git diff range supplied in the delegation prompt. Derive the full list of changed files.
    2. Read each file in full. Apply style fixes in place.
    3. Run the build command supplied in the delegation prompt. If it fails, read errors and fix. Maximum 3 build iterations.
    4. Run the test command supplied in the delegation prompt. If tests fail, read output and fix. Maximum 3 test iterations.
    5. If convergence is not reached within the combined budget, stop without committing and post `[STYLE SWEEP] failed` with the unstaged diff and failing output. The orchestrator will surface this to the operator.
    6. On clean build + clean tests, commit as a single commit with the message supplied in the delegation prompt (default format: `Style sweep: normalize <N> files post-plan`).
- **No-op case:** if nothing needs changing, post `[STYLE SWEEP] no-op` and exit without committing.
- **Output posted to the message board as `[STYLE SWEEP]`:**
    - Files touched (count and full list)
    - Category breakdown (e.g. `12 auto normalizations, 4 east-const, 3 magic-literal hoists, 2 IWYU adds, 1 dead-code removal`)
    - Build outcome, test outcome
    - Commit hash
    - Duration in minutes

**Work:**

- Create the skill file at the path above with the frontmatter and body content.
- Write the body generically — no references to UE, TypeScript, React, or any domain-specific rule set. The sweep agent supplies domain context via its other loaded skills.

**Verification:**

- `grep -rn 'style-sweep-protocol' D:/coding/ue-claude-scaffold/skills/` returns the new file.
- Read-through confirms no domain-specific references in the skill body.

## Phase 2 — Create three style-sweep dynamic agents

**Outcome:** Three new dynamic-agent files exist, each with `model: opus`, Edit / Write tools, `container-git-write`, `style-sweep-protocol`, and the domain style skill(s) their predecessor reviewer loaded. Prose bodies are short — logic lives in the composed skills.

**Files to create:**

- `D:/coding/ue-claude-scaffold/dynamic-agents/container-style-sweep-ue.md`
- `D:/coding/ue-claude-scaffold/dynamic-agents/scaffold-style-sweep.md`
- `D:/coding/ue-claude-scaffold/dynamic-agents/scaffold-server-style-sweep.md`

**Per-agent frontmatter template:**

```yaml
---
name: <name>
description: Terminal style sweep for <track>. Reads every file changed across the plan, normalises style in place, builds, runs tests, commits once. Behaviour-preserving only.
model: opus
color: purple
tools: [Read, Edit, Write, Glob, Grep, Bash]
skills:
  - style-sweep-protocol
  - container-git-write
  - <domain skills — see per-agent list below>
---
```

**Per-agent skill composition** — mirror each predecessor reviewer's skill list, swap `container-git-readonly` for `container-git-write`, drop `review-process`, `review-output-schema`, and `action-boundary` (sweeps do not produce review verdicts):

1. `container-style-sweep-ue` — replaces `container-style-reviewer-ue`
    - Loads: `style-sweep-protocol`, `container-git-write`, `ue-engine-mount`, `ue-cpp-style`, `lint-hook-awareness`
2. `scaffold-style-sweep` — replaces `scaffold-style-reviewer`
    - Loads: `style-sweep-protocol`, `container-git-write`, `scaffold-server-patterns`, `scaffold-dashboard-patterns`, `typescript-async-safety`, `scaffold-test-format`
    - Body note: this sweep only applies pure-presentation normalisations. It must never perform React component-discipline edits (hook/component splits, dep-array trimming, layer refactors) even if it touches `dashboard/**` files — those remain the per-phase React quality reviewer's concern under its own orchestrator.
3. `scaffold-server-style-sweep` — replaces `scaffold-server-style-reviewer`
    - Loads: `style-sweep-protocol`, `container-git-write`, `scaffold-server-patterns`, `typescript-type-remapping`, `typescript-type-discipline`, `typescript-async-safety`, `scaffold-test-format`
    - Body note: inherits the "one axis, not two — TS type discipline folds into style" framing from the predecessor reviewer.

**Per-agent prose body (under 20 lines):**

- One sentence stating: "You are the terminal style sweep for \<track>. You run once at the end of a plan, edit in place, build, run tests, and commit as a single work unit."
- Reference `style-sweep-protocol` as the authoritative process.
- Track-specific scope caveats only (e.g. `scaffold-server-style-sweep` edits only `server/**`; `scaffold-style-sweep` edits across `server/` and `dashboard/` but never performs React component-discipline edits).
- Do not restate the in-scope / out-of-scope list — it lives in the protocol skill.

**Work:**

- Create all three files with the frontmatter, skills list, and prose body defined above.
- Before writing any agent, confirm `container-git-write` exposes the commit + push pattern the sweep needs. If it does not, surface that — do not invent a local workaround inside an agent file.

**Verification:**

- `grep -rn 'container-style-sweep-ue\|scaffold-style-sweep\|scaffold-server-style-sweep' D:/coding/ue-claude-scaffold/dynamic-agents/` returns exactly the three new files.
- Each new agent's frontmatter has `model: opus` and includes `Edit` + `Write` in its tools list.
- None of the three new agents loads `container-git-readonly`.
- No new `*-react-quality-sweep*` file exists — the dashboard tracks are out of scope.

## Phase 3 — Wire style-sweep into the three in-scope orchestrators and update the phase protocol

**Outcome:** The three in-scope orchestrator families run only safety + correctness in their per-phase parallel fan-out, and invoke their track-specific style-sweep agent as a terminal Final Stage. The two dashboard orchestrators remain unchanged: their wirings keep declaring `style-reviewer → scaffold-dashboard-react-quality-reviewer` and do not declare a sweep. Protocol and wiring land together as a single atomic change so no intermediate commit leaves a dangling reference.

**Files to edit:**

- `D:/coding/ue-claude-scaffold/skills/orchestrator-phase-protocol/SKILL.md`
- `D:/coding/ue-claude-scaffold/skills/orchestrator-system-wiring/SKILL.md`
- `D:/coding/ue-claude-scaffold/skills/scaffold-system-wiring/SKILL.md`
- `D:/coding/ue-claude-scaffold/skills/scaffold-server-system-wiring/SKILL.md`

**Files explicitly NOT edited (must remain untouched):**

- `D:/coding/ue-claude-scaffold/skills/scaffold-dashboard-system-wiring/SKILL.md`
- `D:/coding/ue-claude-scaffold/skills/content-catalogue-dashboard-system-wiring/SKILL.md`

**Changes to `orchestrator-phase-protocol/SKILL.md`** — the revision makes both the per-phase style slot and the terminal sweep opt-in per wiring, so in-scope wirings adopt the sweep while dashboard wirings keep their per-phase reviewer with no behavioural change:

- Step 2 parallel fan-out: `safety-reviewer` and `reviewer` (correctness) are **always required**. `style-reviewer` is **optional** — run it only if the loaded wiring skill declares a `style-reviewer` row in its Agent Resolution table. Wirings that declare a `style-sweep` row instead of `style-reviewer` skip the per-phase style slot.
- Step 2 scope-selection rule: keep the general "match reviewers to the nature of the changed files" guidance. Style-reviewer in-or-out guidance can remain; it only applies when the wiring declares one.
- Step 2a consolidation still batches all findings from whichever reviewers ran. The "unambiguous style fixes in touched files" instruction to the implementer **stays** for all wirings.
- Step 2c posting: tags follow the wiring's declaration. Wirings that declare a style-reviewer still post `[STYLE REVIEW]` (or their declared tag override, e.g. `[REACT QUALITY REVIEW]`). Wirings that declare a sweep post no per-phase style tag and instead post `[STYLE SWEEP]` at the terminal stage.
- Decomposition Re-review (Decomp Step 4): same rule — include `style-reviewer` only if the wiring declares one.
- Insert a new **Final Stage — Style Sweep** section after the Decomposition Review, before Final Output. The section opens with the opt-in statement, then describes the delegation:

    ```
    ## Final Stage — Style Sweep

    Run this stage only if your wiring skill declares a `style-sweep` agent in its Agent Resolution table. Wirings that do not declare a sweep skip directly to Final Output.

    After the decomposition review and its re-review pass have completed successfully, run a single terminal style pass. This is the last code-modifying stage before Final Output.

    ### Style Step 1 — Collect changed files
    Produce the full list of files changed across all phases including decomposition. Use `git diff <branch-base>..HEAD --name-only`. Scope the list to the extensions covered by the loaded domain style skill.

    ### Style Step 2 — Delegate
    Post `style_sweep_start` to `general`. Delegate to the `style-sweep` agent named in your wiring skill with:
    - The `git diff` range the pass should inspect (`<branch-base>..HEAD`)
    - The full list of changed files
    - The project build command (named in your wiring skill)
    - The project test command (named in your wiring skill)
    - The commit message convention for the sweep commit (named in your wiring skill)

    ### Style Step 3 — Post result
    Post the agent's `[STYLE SWEEP]` output to `general`. Three possible terminal states:
    - `no-op` — nothing was changed. Proceed to Final Output.
    - Clean sweep with a commit — verify `git status` is clean and the new commit exists. Proceed to Final Output.
    - `failed` — the sweep could not converge. Post `phase_failed` with the reason and stop. Operator input required.

    The style sweep is **not re-reviewed**. It is terminal by design. Its verification is the build and test green-light it performs internally.
    ```

- Update the Final Output template:
    - The per-phase `Style Review` line becomes conditional — rename it to reflect that it only appears if the wiring runs one, or write it as "Style Review: PASS / N BLOCKING / N WARNING addressed / NOT APPLICABLE (wiring uses terminal sweep)". Pick the phrasing that keeps the template parseable by the dashboard.
    - Insert a `Final Style Sweep` block after `Decomposition Review`, also conditional:

        ```
        ### Final Style Sweep (if wiring declares a sweep)
        - Verdict: APPROVE (N files normalized, commit <hash>) / NO-OP / FAILED
        - Build: PASS/FAIL
        - Tests: PASS/FAIL
        ```

**Changes per in-scope wiring skill (apply the same shape to all three):**

- Replace the `style-reviewer` row in the Agent Resolution table with a `style-sweep` row mapped to the track-specific sweep agent created in Phase 2.
- Remove any per-phase style-slot tag override — none currently set in these three wirings, but double-check and strip if present.
- Add a new **Style Sweep Commands** sub-section naming, for that track:
    - Build command
    - Test command
    - Commit message format (default `Style sweep: normalize <N> files post-plan`)
- Before writing each wiring's concrete build and test commands, read that wiring skill and confirm the commands the implementer already uses. Reuse them exactly — do not invent new commands. Concrete commands per wiring:
    - `orchestrator-system-wiring` (UE): reuse the UE implementer's build command (`python Scripts/build.py --summary`). Reuse the UE implementer's test command.
    - `scaffold-system-wiring`: reuse whatever aggregate build and test commands the wiring already declares for the implementer.
    - `scaffold-server-system-wiring`: reuse the `server/` build and test commands the wiring already declares.

**Work:**

- Edit all four files as specified (the phase-protocol skill plus the three in-scope wirings).
- Do not touch the two dashboard wirings. If their content surfaces during editing (e.g. diff review), leave it alone.
- Do not change the cycle budget (5), the WARNING-blocking policy, or the consolidation pattern.
- Do not change any language about the implementer's inline style rule.

**Verification:**

- `grep -n 'style-reviewer' D:/coding/ue-claude-scaffold/skills/orchestrator-system-wiring/SKILL.md D:/coding/ue-claude-scaffold/skills/scaffold-system-wiring/SKILL.md D:/coding/ue-claude-scaffold/skills/scaffold-server-system-wiring/SKILL.md` returns zero hits.
- `grep -n 'style-reviewer' D:/coding/ue-claude-scaffold/skills/scaffold-dashboard-system-wiring/SKILL.md D:/coding/ue-claude-scaffold/skills/content-catalogue-dashboard-system-wiring/SKILL.md` returns unchanged hits versus pre-plan state (these wirings keep their per-phase reviewer).
- `grep -n 'style-sweep\|STYLE SWEEP' D:/coding/ue-claude-scaffold/skills/` returns hits in `orchestrator-phase-protocol/SKILL.md` and exactly the three in-scope wiring skills. Zero hits in the two dashboard wirings.
- The `orchestrator-phase-protocol/SKILL.md` skill phrases the per-phase style slot and the Final Stage — Style Sweep both as opt-in per wiring.
- Each of the three in-scope wiring skills' Agent Resolution tables contains exactly one sweep row mapped to a real agent file in `dynamic-agents/`. Each contains a Style Sweep Commands sub-section.

## Phase 4 — Retire the three obsoleted style-reviewer dynamic agents

**Outcome:** The three in-scope dynamic-agent style-reviewer files are deleted. `scaffold-dashboard-react-quality-reviewer.md` **remains live and untouched** — it is still referenced by the two dashboard wirings. No reference to the three removed reviewers remains in `skills/`, `dynamic-agents/`, `scripts/`, `container/`, `server/`, `dashboard/`, `CLAUDE.md`, or `.claude/` outside git history and prior planning notes.

**Files to delete:**

- `D:/coding/ue-claude-scaffold/dynamic-agents/container-style-reviewer-ue.md`
- `D:/coding/ue-claude-scaffold/dynamic-agents/scaffold-style-reviewer.md`
- `D:/coding/ue-claude-scaffold/dynamic-agents/scaffold-server-style-reviewer.md`

**Files that must stay:**

- `D:/coding/ue-claude-scaffold/dynamic-agents/scaffold-dashboard-react-quality-reviewer.md` — still the style-reviewer for both dashboard orchestrators.

**Work:**

- Delete the three files above via `git rm`.
- `grep -rn 'container-style-reviewer-ue\|scaffold-style-reviewer\|scaffold-server-style-reviewer' D:/coding/ue-claude-scaffold` — for every hit outside `Notes/` and this plan file:
    - If the reference is documentation describing the old flow, update it to describe the sweep-based flow.
    - If the reference is a reviewer-list enumeration, replace with the corresponding sweep agent name, or delete if the entry was per-phase-style-specific.
    - If the reference is a test fixture or config, update or delete as appropriate.
- Do not grep or edit any reference to `scaffold-dashboard-react-quality-reviewer` — that reviewer is not being retired.
- Update `CLAUDE.md` if it names any of the three removed reviewers.

**Verification:**

- `grep -rn 'container-style-reviewer-ue\|scaffold-style-reviewer\|scaffold-server-style-reviewer' D:/coding/ue-claude-scaffold` returns hits only in `Notes/` and this plan file.
- `grep -rn 'scaffold-dashboard-react-quality-reviewer' D:/coding/ue-claude-scaffold` returns hits in at least the two dashboard wiring skills and the reviewer's own dynamic-agent file.
- Scaffold server tests pass (`npm test` in `server/`).

## Phase 5 — End-to-end smoke test per in-scope track family plus a dashboard regression check

**Outcome:** A representative real run for each in-scope orchestrator family completes successfully with the new protocol. Every in-scope run shows safety + correctness review per phase only, and a single terminal style sweep afterward. One dashboard run is separately exercised to confirm its protocol is unchanged.

**In-scope track families to exercise (must pass):**

1. UE (`container-orchestrator-ue`) against PistePerfect
2. Scaffold root (`scaffold-orchestrator`) against the scaffold repo itself
3. Scaffold server (`scaffold-server-orchestrator`) against the scaffold's own `server/`

**Out-of-scope regression check (must be unchanged):**

4. Scaffold dashboard (`scaffold-dashboard-orchestrator`) against the scaffold's own `dashboard/` — verify per-phase `[REACT QUALITY REVIEW]` still fires and no `[STYLE SWEEP]` appears. This run exists only to confirm the dashboard protocol was not accidentally altered.

**Work:**

- Pick or author a small 2-phase plan per track family — enough code change to produce real style drift. A no-op phase does not exercise the sweep meaningfully.
- Launch each container family in turn. Monitor via `./status.sh --follow` and the dashboard.
- After each in-scope completion, verify:
    - Per-phase messages include `[SAFETY REVIEW]` and `[CORRECTNESS REVIEW]` only — never `[STYLE REVIEW]`.
    - A single `[STYLE SWEEP]` message is posted after the decomposition review completes.
    - If the sweep made changes, exactly one commit with the wiring-supplied sweep message exists on the agent branch after all phase commits and decomposition commits.
    - The Final Summary message contains a `Final Style Sweep` section.
    - Build and tests for the sweep commit are both PASS.
- After the dashboard regression run, verify:
    - Per-phase messages include `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`, and `[REACT QUALITY REVIEW]` exactly as before.
    - No `[STYLE SWEEP]` message is posted at any point.
    - The Final Summary contains no `Final Style Sweep` block.

**Verification:**

- Dashboard timeline and `git log` for each in-scope run match the expected sweep sequence.
- Dashboard regression run matches the pre-plan sequence — no new messages, no new commits beyond what the old protocol produced.
- Any failure triggers an iteration on the failing sweep agent's prose, the protocol skill, or the wiring skill — in that order — before the phase is called done.
