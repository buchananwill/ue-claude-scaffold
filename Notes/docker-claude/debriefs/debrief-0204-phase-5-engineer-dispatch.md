# Debrief 0204 — Phase 5: Engineer top-level session dispatch

## Task Summary

Phase 5 of the durable-task FSM rework: equip the container daisy-chain with
an engineer-specific top-level session prompt builder and amend the
implementer agent definition to declare its FSM transition responsibilities.

The engineer prompt must select one of three branches based on FSM state read
from `GET /tasks/:id`:

1. `reviewCycleCount == 0` — standard implement-from-plan.
2. `reviewCycleCount > 0` and no arbitration addendum — read the consolidated
   review at `latestReviewPath`, fix BLOCKING entries, repost `built`.
3. `reviewCycleCount > 0` and `arbitrationAddendumPath` set — read both files;
   the addendum is authoritative where it conflicts with the consolidated
   review.

The engineer must post its own transitions (`built` or `failed`); the wrapper
no longer auto-posts `/complete` or `/fail`. The prompt names exact endpoints
and literal `failureReason` enum values so the engineer cannot trip the CHECK
constraint with free-text values.

## Changes Made

- **`container/lib/run-claude.sh`**:
  - Added `_build_engineer_prompt(task_id)` — fetches fresh task state from
    `GET /tasks/:id`, branches on cycle/addendum, emits the engineer prompt.
    Includes header (TASK_ID/TITLE/PLAN_PATH/REVIEW_CYCLE_COUNT), per-branch
    body, transition contract block (built / failed with literal
    `engineer_build_failure`), and contradiction escape hatch (literal
    `reviewer_contradiction`).
  - Wired into `_run_claude`: when `DAISY_CHAIN_ROLE=engineer` and a task ID
    is set, the prompt passed in by the pump-loop is replaced with the
    engineer-specific prompt before the audit dump and claude invocation.
- **`dynamic-agents/container-implementer-ue.md`**: appended a small
  amendment naming the new `built` / `failed` / `arbitrating` transition
  endpoints, the literal failureReason / trigger enum values, and the
  "read latestReviewPath / arbitrationAddendumPath on demand, do not
  paraphrase reviewer findings into working memory" rule.
- **`.compiled-agents/container-implementer-ue.md`** (+ `.meta.json`):
  regenerated mechanically via `node server/dist/bin/compile-agent.js`.
- **`server/src/routes/tasks-types.ts`**: surfaced three FSM read-side fields
  (`reviewCycleCount`, `latestReviewPath`, `arbitrationAddendumPath`) on
  `TaskRow`, `toTaskRow`, and `formatTask`. Without this the prompt builder
  cannot see the data required by the plan's three branches.

## Design Decisions

### Honour `--agent <name>` and `--output-format stream-json` (plan flag-set adapted)

The plan's pseudocode shows `--append-system-prompt "$(cat ....md)"` and
`--output-format json`. The scaffold's existing convention is `--agent <name>`
(server picks up the compiled definition automatically) and
`--output-format stream-json` (the abnormal-exit detector greps for
`"type":"result"` events on a per-line basis). I kept the existing flag set
because:

- The instructions explicitly call out "Honour the plan's *intent* (a
  top-level Claude session running the implementer system prompt, capable of
  spawning sub-agents, building a state-aware engineer prompt from server
  data), while preserving the existing `--agent` mechanism, stream-json
  output, session-lifecycle plumbing, abnormal-exit detection, and
  `_finalize_session`. Do not regress those."
- Phase 4's daisy-chain already routes `DAISY_CHAIN_ROLE=engineer` through
  the `--agent` lookup against the resolved roles JSON.
- `--output-format stream-json` is load-bearing for `_detect_abnormal_exit`
  and for the per-line output capture the session-finalize PATCH depends on.

The plan's intent — a top-level session with the implementer system prompt,
backed by an FSM-state-aware user prompt — is fully delivered. The harness
plumbing is just the existing convention.

### Prompt builder lives in `run-claude.sh`, not `pump-loop.sh`

The plan says "Provide a `_run_engineer_session` (or hook it into the
existing `_run_role_session` flow)". File ownership for this task does not
include `pump-loop.sh`. I extended `_run_claude` itself to detect
`DAISY_CHAIN_ROLE=engineer` and substitute the engineer prompt — the
pump-loop's generic `_build_task_prompt` is overwritten in `_run_claude`
before the audit dump and claude invocation. This is a minimal extension
(no `pump-loop.sh` touch required) and keeps a single seam for future
roles (reviewer, arbitrator) to similarly substitute role-specific prompts
in Phases 6/7.

### Surfacing FSM fields on `formatTask` (out-of-scope file: minimum viable fix)

The plan requires the engineer prompt builder to read `reviewCycleCount`,
`latestReviewPath`, and `arbitrationAddendumPath` from `GET /tasks/:id`.
Those fields exist on the `tasks` table (per Phase 1 schema) but were not
exposed by `formatTask` — only writes flowed through them via Phase 2's
`/transition`. Without surfacing them on the API response, the prompt
builder has no way to read fresh state.

This is the build-error / minimum-viable-fix exception: the plan's
specified behaviour is undeliverable without this change. The edit is
purely additive (three nullable read-only fields) and does not regress
any existing behaviour. Verified the `tasks-lifecycle.test.ts` suite (45
tests, all pass) and the broader `tasks.test.ts` suite (55/57 pass; the
2 failures are pre-existing unrelated bulk-delete-by-status failures
also present on baseline).

### `${var:-default}` parameter expansion bug fixed during inspection

First draft of branches 2/3 used `${latest_review_path:-<...${SERVER_URL}/tasks/${task_id}>}`.
Bash parses the default arm greedily and an unescaped inner `}` from
`${SERVER_URL}` / `${task_id}` closes the outer expansion, splicing
trailing literal text. Caught by the inspection acceptance check (cycle 2
fixture rendered `consolidated.md/tasks/42>}` instead of just
`consolidated.md`). Replaced with explicit `local lrp_display="$var"; [
-z "$lrp_display" ] && lrp_display=...` two-liner. Documented inline.

## Build & Test Results

- `bash -n container/lib/run-claude.sh` — clean.
- `npm run typecheck --prefix server` — clean.
- `npx tsx --test server/src/routes/tasks-lifecycle.test.ts` —
  45/45 pass (no regressions).
- `npx tsx --test server/src/routes/tasks.test.ts` — 55/57 pass.
  The two failures (`deletes completed tasks and returns count`, `scopes
  deletion to the requesting project`) are pre-existing on baseline (verified
  via `git stash` + re-run on staging branch tip) and unrelated to the
  surfaced FSM fields.
- Inspection acceptance check on `_build_engineer_prompt` against synthetic
  task JSON for cycle 0, cycle 2 no addendum, cycle 2 with addendum, and
  server-unreachable fallback — all four branches render the expected text
  with the literal failure-reason / trigger enum values inline.
- `compile-agent` regenerated `.compiled-agents/container-implementer-ue.md`
  + `.meta.json` containing the FSM transition amendment.

## Open Questions / Risks

- Branches inside the engineer prompt do not currently fall back to a
  `cycle` task status (the ad-hoc 11th status in the schema CHECK
  constraint). If a task ever lands in `cycle` status with the engineer
  role mapped, `_build_engineer_prompt` still emits a cycle-0 prompt
  because the gating is on `reviewCycleCount`, not status. That mirrors
  the FSM contract — `reviewCycleCount` is the load-bearing counter — so
  this is intentional, but worth confirming during Phase 6/7 integration.
- The engineer prompt does not embed reviewer-role names per task. If
  future work needs the engineer to look up "which reviewers blocked you"
  before reading `latestReviewPath`, that is a server-side fetch the
  agent does at runtime via `GET /tasks/:id` (which now exposes
  `reviewerVerdicts` indirectly through verdict-related routes) — not a
  prompt-time concern.

## Suggested Follow-ups

- A round-trip integration test that drives a task from `claimed` →
  `engineering` → `built` through the daisy-chain with a stubbed engineer
  agent, verifying the prompt builder's output is what the agent sees.
  Phase 9 cutover work.
- Consider exposing `reviewerVerdicts` and `failureReason` on `formatTask`
  too once Phase 6/7 land — they are useful for dashboard rendering and for
  agents debugging stuck tasks.
- The `_build_engineer_prompt` helper is ~150 lines. If Phase 6/7 grow it
  with reviewer/arbitrator-specific helpers, consider splitting the
  prompt builders into `container/lib/role-prompts.sh`. Not warranted yet.
