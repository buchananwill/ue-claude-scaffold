# Skill Language Review — 2026-05-06

Source: review of all `skills/*/SKILL.md` plus the last ~80 messages on the
coordination server's `general` channel (NavModifier USTRUCTs run + shell-script
decomposition run).

User instructions: read the suggestions, mark each with approval / uncertainty /
disagreement inline, then we discuss.

Status legend (fill in inline):

- `[ ]` undecided
- `[~]` uncertain — talk it through
- `[x]` approved
- `[!]` rejected

---

## Signal from the message board

Two recent runs surfaced four recurring failure modes:

1. **Reviewers BLOCK on plan-mandated patterns.** Style and safety reviewers
   flagged `virtual` USTRUCTs, `BlueprintType` on a polymorphic base, and
   `Radius=100.f` as defects — all explicitly required by the plan and
   confirmed as established codebase patterns (`FEventCondition`,
   `FEventOutcome`, `FGuestAffectFragmentWrapper`). The orchestrator burned
   cycles overriding "FALSE POSITIVE".
2. **Reviewers BLOCK on out-of-scope / future-phase work.** Style reviewer
   flagged "status.sh not updated to source colors.sh" as Phase 1 BLOCKING when
   callers update in Phases 11-14.
3. **Reviewers contradict prior cycles.** Cycle 1 safety told the implementer
   to use hardcoded strings (security); cycle 2 style told them to use `$1`
   (DRY). Implementer is whipsawed.
4. **Build-infra failures get reported as build failures.** `syncWorktree git
   fetch ENOENT` and `HOOK_BUILD_INTERCEPT=false` get classified as
   `outcome: fail` or "Build: SKIP" rather than as infra errors that should
   halt the phase.

Plus one observability nit: sub-agent smoke-test posts duplicate the
orchestrator's (`[ORCHESTRATOR] Agent online` and `[IMPLEMENTER] Agent online`
from the same `fromAgent`).

---

## High-impact suggestions

### [~] 1. Pattern-verification rule for reviewers

**Files**: `skills/general-correctness/SKILL.md`, `skills/ue-safety/SKILL.md`,
`skills/ue-correctness/SKILL.md`, `skills/ue-decomposition/SKILL.md`,
`skills/react-component-discipline/SKILL.md`,
`skills/browser-web-hygiene/SKILL.md`.

**Direction**: Add a "Pattern verification before BLOCKING an idiom" section.
Before flagging an idiom (e.g. `virtual` USTRUCT, raw pointer,
`dangerouslySetInnerHTML`, `auto*` after `Cast`), grep the codebase for the
pattern. If 3+ established sibling instances exist as convention, downgrade to
NOTE and let the operator decide whether to deprecate the convention. The
reviewer's job is to flag *deviations* from the project's idioms, not to rule
on the idioms themselves.

**Evidence**: virtual USTRUCT flagged BLOCKING by two reviewers in two
consecutive runs; correctness reviewer correctly recognized the pattern.

**Notes**:

> _user notes here_

---

### [~] 2. Phase-scope discipline for review findings

**File**: `skills/review-output-schema/SKILL.md`.

**Direction**: Add a "Phase scope" rule. A finding that names a missing edit in
a file outside the implementer's stated scope is a NOTE, not BLOCKING — unless
the plan explicitly required this phase to touch that file. Reviewers must read
the phase's stated scope (which the orchestrator passes via plan path + phase
ID) and constrain BLOCKING findings to files in scope.

**Evidence**: shell-decomp Phase 1 cycle 2 flagged `status.sh` / `launch.sh` /
`stop.sh` as BLOCKING — caller updates were Phases 11-14.

**Notes**:

> _user notes here_

---

### [~] 3. No-contradicting-prior-cycles rule

**File**: `skills/review-output-schema/SKILL.md`.

**Direction**: Add a "Cycle continuity" rule. If a previous cycle's review
explicitly mandated approach X, and a finding in the current cycle recommends
not-X, the reviewer raises it as a NOTE addressed to the orchestrator, not a
BLOCKING. Reviewers don't litigate against each other through the implementer.

**Evidence**: cycle 1 safety asked for hardcoded strings; cycle 2 style flagged
hardcoded strings as BLOCKING.

**Notes**:

> _user notes here_

---

### [~] 4. `review-process` Step 2 should require reading the plan first

**File**: `skills/review-process/SKILL.md`.

**Direction**: Step 2 ("Read Full Context") needs an explicit Step 2.0: "If the
orchestrator supplied a plan path + phase ID, read that phase first. Identify
the explicit invariants and any patterns the plan mandates. Reviewers who
BLOCK on plan-mandated patterns are wasting cycle budget." Dovetails with the
behaviour-contract change just landed.

**Notes**:

> _user notes here_

---

## Medium-impact suggestions

### [x] 5. Stale linter reference

**File**: `skills/lint-hook-awareness/SKILL.md`, line 8.

The skill says `lint-cpp-diff.py`. The actual file is
`container/hooks/lint-cpp-diff.mjs` (Node ESM). One-line fix.

**Notes**:

> _user notes here_

---

### [~] 6. Build-infra error protocol

**File**: `skills/container-build-routing/SKILL.md`.

**Direction**: Add an "Infra failure" section. When the hook itself fails
(`syncWorktree git fetch ENOENT`, `HOOK_BUILD_INTERCEPT=false`, hook
unreachable), the implementer classifies it as `infra-error` (not `fail`),
posts a status update tagged so the operator can intervene, and **halts the
phase**. Do not declare `phase_complete` with `Build: SKIP`; do not proceed to
review without verification. The current "Do NOT skip the build" rule is too
forceful and offers no escape hatch when the hook is genuinely broken.

**Evidence**: nav-modifier Phase 1 first run completed with `Build: SKIP
(HOOK_BUILD_INTERCEPT=false)`; subsequent runs hit `git ENOENT`. Both proceeded
to review and `phase_complete`.

**Notes**:

> _user notes here_

---

### [!] 7. Smoke-test message scoping

**File**: `skills/message-board-protocol/SKILL.md`, "Smoke Test — First
Message".

**Direction**: Scope the smoke test to *top-level container agents only*.
Sub-agents invoked via the Agent tool inherit the container's identity — their
"Agent online" post duplicates the orchestrator's. Clarify: "If you were
spawned by another agent in the same container (i.e., as an Agent-tool
sub-agent), skip the smoke test; the parent has already posted online."

**Evidence**: every run shows pairs of `[ORCHESTRATOR] Agent online` /
`[IMPLEMENTER] Agent online` from the same `fromAgent`.

**Notes**:

> _user notes here_

---

### [x] 8. Behaviour-vs-sample wording in `general-correctness` Specification Compliance

**File**: `skills/general-correctness/SKILL.md`, lines 12-16.

**Direction**: Tighten the bullet "Was anything introduced that the spec did
NOT ask for?" — given the new behaviour contract, surface adaptations
(renames, helper splits, idiom swaps) are *not* unsolicited features. Restrict
the rule to behavioural additions: extra side effects, extra return
information, extra computed state. Today's wording could be read to
re-litigate behaviour-preserving style adaptations.

**Notes**:

> _user notes here_

---

## Low-impact polish

### [x] 9. `design-leader-protocol` self-onboarding window

**File**: `skills/design-leader-protocol/SKILL.md`, Phase 2. (Same change in
`skills/design-member-protocol/SKILL.md`.)

60 seconds for "read code, research, post Ready" is unrealistic in practice.
Suggest "up to 3 minutes, or until all members have posted Ready."

**Notes**:

> _user notes here_

---

### [x] 10. `task-worker-protocol` ambiguity handling

**File**: `skills/task-worker-protocol/SKILL.md`, "If the Task Is Unclear".

**Direction**: Distinguish behaviour ambiguity from surface ambiguity,
mirroring the behaviour-contract change. Behaviour ambiguity → post `query`
and stop (the contract is unclear). Surface ambiguity (which file, what
naming) → conservative interpretation and proceed. Today's text says "proceed
with the most conservative interpretation" for both.

**Notes**:

> _user notes here_

---

### [!] 11. `debrief-protocol` filename counter format

**File**: `skills/debrief-protocol/SKILL.md`, "File Location and Naming".

The skill says "zero-padded 4-digit counter". Real filenames in recent runs
use date-like prefixes (`debrief-0107-...`, `debrief-0108-...`), suggesting
MM-DD or similar. Either codify the date convention or restate that it's a
serial counter and ask agents to actually maintain the count.

**Notes**:

> _user notes here_ Not sure what you're on about. I see zero schema violations in the debriefs.

---

### [~] 12. `shell-script-safety` — `printf` over `echo -e`

**File**: `skills/shell-script-safety/SKILL.md`.

Add a short rule: prefer `printf '%s\n' "$value"` over `echo -e "$value"` when
`$value` is interpolated user/agent data — `echo -e` reinterprets `\n`, `\t`,
etc., which can corrupt content or trigger lint warnings. Real review flagged
"echo -e with interpolated value" recently.

**Notes**:

> _user notes here_

---

### [!] 13. `channel-isolation` reinforces the file-handoff lesson

**File**: `skills/channel-isolation/SKILL.md`.

Already says "files invisible across containers" — add an explicit example:
design-team deliverables must be posted to the channel via `reply`, then
optionally also written to disk for the operator. Don't draft a deliverable as
a file expecting teammates to fetch the branch — they can't see it. Mirrors
the memory feedback `feedback_design_team_channel_discipline.md`.

**Notes**:

> _user notes here_

---

### [~] 14. `quality-philosophy` could call out cycle-budget cost

**File**: `skills/quality-philosophy/SKILL.md`.

One sentence to add: "Every BLOCKING you raise consumes the phase's cycle
budget. Do not pad with idioms or style preferences that the codebase has
already decided. Reject lazy work; do not manufacture work." Complements the
pattern-verification rule.

**Notes**:

> _user notes here_

---

### [!] 15. Drop or reduce the `[ROLE]` prefix-in-payload requirement

**Files**: `skills/orchestrator-message-discipline/SKILL.md`,
`skills/message-board-protocol/SKILL.md`.

The `[ORCHESTRATOR]` / `[IMPLEMENTER]` prefix is redundant with `fromAgent`
from the API perspective — but the dashboard timeline likely shows it as
visual metadata for the operator. **Open question**: keep, drop, or drop only
on `phase_*` payloads (where the type already conveys the role)?

**Notes**:

> _user notes here_

---

## Things I checked and would NOT change

- `skills/quality-philosophy`, `skills/audit-protocol`,
  `skills/audit-matrix-schema`, `skills/commit-discipline`,
  `skills/action-boundary`: tight and current.
- `skills/ue-cpp-style`: the `.Get()` section and the auto/east-const sections
  are excellent and well-evolved.
- The five `mandate-*` skills: precise scope; no edits warranted.
- The `*-system-wiring` skills: structurally consistent; the "no-tester /
  style-sweep is terminal / no per-phase style" pattern is well-articulated.
- `skills/typescript-type-discipline`: aligns with the "type-discipline is
  style" memory feedback (already loaded by the style sweep, no separate type
  reviewer).
