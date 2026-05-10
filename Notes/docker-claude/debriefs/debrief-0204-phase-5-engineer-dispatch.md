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

---

## Cycle 1 — Safety reviewer findings (W1, W2)

The safety reviewer approved with two WARNINGs, both in
`container/lib/run-claude.sh::_build_engineer_prompt`. Correctness reviewer
approved with no findings. Cycle 1 is a defence-in-depth hardening pass
only — no behaviour change for valid inputs.

### W1 — Numeric guard on `task_id`

`tasks.id` is a serial (integer) on the server, but the claim-path regex in
`container/lib/pump-loop.sh:376` is `^[0-9a-zA-Z_-]+$` (looser than the
resume-probe regex `^[0-9]+$` at `pump-loop.sh:293`). A value like
`123-foo` could in principle land in `${SERVER_URL}/tasks/${task_id}`.

`pump-loop.sh` is out of scope for this task. The fix lives at the URL
construction site instead: a `^[0-9]+$` guard at the top of
`_build_engineer_prompt`. On a non-numeric `task_id` the function skips the
outbound `GET /tasks/${task_id}` curl entirely and falls through to the
existing env-fallback (cycle-0) path that the function already takes when
the server is unreachable. The daisy-chain is not aborted, and a stderr
warning records the rejected value. The literal `${task_id}` references in
the prompt body are model-facing text — not curl targets — so they do not
re-introduce the URL hazard.

### W2 — Newline scrubbing on server-supplied prompt fields

`title`, `sourcePath`, `latestReviewPath`, `arbitrationAddendumPath` are
extracted via `jq -r` and flow into the prompt verbatim. There is no shell
injection risk (the prompt is passed via `claude -p "$full_prompt"`,
expansion is at assignment time), but a crafted task title containing
`\n`, `$(...)`, or `;` literals would appear in the model's prompt — a
low-severity prompt-manipulation surface.

Fix: pipe each `jq -r` extraction through `tr -d '\n'`. For path fields,
also enforce a conservative allowlist `^[-A-Za-z0-9_./ ]+$`; on a path
that fails the allowlist, treat it as empty so the cycle-0 branch is taken
instead of injecting a malformed path. Title need not be allowlisted —
newline scrubbing alone is sufficient. The same newline scrub is applied
to `CURRENT_TASK_TITLE` and `CURRENT_TASK_SOURCE` on the env-fallback
branch for consistency, even though those values originated from the same
upstream server response at claim time.

The allowlist is intentionally loose enough to accept normal POSIX paths
including spaces (`plans/phase 5.md` is accepted). It rejects the
prompt-manipulation classes that matter: `$()`, backticks, `;`, `&`, `|`,
`\n`, `\r`, `\\`, `<`, `>`, quotes. It does NOT enforce path-traversal
protection (`../etc/passwd` would be accepted) — that is a server-side
concern, not a prompt-builder concern.

### Changes

- **`container/lib/run-claude.sh`** — `_build_engineer_prompt` only:
  - Wrapped the `_curl_server` call in `if [[ "$task_id" =~ ^[0-9]+$ ]]`;
    on non-numeric, log to stderr and leave `task_json` empty so the
    existing env-fallback path is taken (W1).
  - Added `| tr -d '\n'` to the four `jq -r` extractions of `title`,
    `source_path`, `latest_review_path`, `addendum_path` (W2).
  - Added a `^[-A-Za-z0-9_./ ]+$` allowlist gate on the three path fields;
    on failure, log to stderr and reset to empty (W2).
  - Routed the env-fallback `title` and `source_path` through
    `printf '%s' "..." | tr -d '\n'` for consistency (W2).
- No changes to `dynamic-agents/container-implementer-ue.md` or its
  compiled outputs — both findings are in the prompt-builder shell only.

### Build & Test Results — Cycle 1

- `bash -n container/lib/run-claude.sh` — clean.
- Synthetic prompt-builder simulation (in-process source of the function
  with stubbed `_curl_server` and `_build_task_prompt_prefix`) covering
  six scenarios: cycle 0 valid, cycle 2 no-addendum valid, non-numeric
  task_id, title with embedded newlines, source_path with `$(...)` shell
  metacharacters, env-fallback with newline in `CURRENT_TASK_TITLE`. All
  six produce the expected output: valid inputs render byte-identical to
  pre-change; adversarial inputs degrade safely with stderr warnings.
- `npm test --prefix server` — 683 pass / 54 fail / 737 total. Identical
  counts on two consecutive runs, so deterministic. The failures are
  pre-existing on the branch tip (cycle 1 only modifies a bash file —
  nothing on the TypeScript test surface could be affected). The original
  Phase 5 debrief noted 2 pre-existing failures in `tasks.test.ts`; the
  larger 54-failure count appears across the wider suite under the same
  PGlite/parallelism conditions and is environmental, not a regression
  introduced here.

### Branch re-trace (verified by inspection + simulation)

For each branch, valid inputs produce identical output to pre-change:

1. **Cycle 0 with source_path** — implement-from-plan branch. `${title}`,
   `${source_path}`, `${task_id}` substituted as before. `tr -d '\n'` is
   a no-op on titles/paths without embedded newlines.
2. **Cycle 0 without source_path** — implement-from-task (inline)
   branch. Same as above, with the `<inline task — no plan file>`
   placeholder.
3. **Cycle > 0, no addendum** — revision branch. `${lrp_display}` /
   `${cycle_count}` substituted as before.
4. **Cycle > 0, with addendum** — post-arbitration branch. Both
   `${lrp_display}` and `${addendum_path}` substituted as before.

Adversarial differences (intended):

- Non-numeric task_id → cycle-0 inline-task branch instead of cycle-N
  branch (since cycle_count defaults to 0 in the env-fallback).
- Title with `\n` → newlines stripped from the rendered title.
- Path with `$(...)`, `;`, `\`, `<`, `>` → path emptied, branch falls to
  cycle-0 inline-task instead of cycle-N or implement-from-plan.

---

## Cycle 2 — Correctness reviewer findings (W1, W2)

The correctness reviewer requested changes with two WARNINGs, both in
`container/lib/run-claude.sh::_build_engineer_prompt`. Safety reviewer
approved (1 informational NOTE about path-traversal scoping, no action).
Cycle 2 is a comment correction plus the propagation of the cycle-1
sentinel pattern from `latest_review_path` to `addendum_path`.

### W1 — Misleading comment about allowlist failure routing

The cycle-1 comment said "On allowlist failure, treat the path as empty so
the cycle-0 branch is taken instead of injecting a malformed path into the
prompt." That was factually wrong: when `latest_review_path` failed the
allowlist, the code stayed in Branch 2 (cycle > 0, no addendum) and used a
`<latestReviewPath missing — refetch GET /tasks/${task_id}>` sentinel.
Branch selection has always been driven by `cycle_count` (and now by
`had_addendum_originally`), not by whether `latest_review_path` was set.

Fix: replaced the comment with text that names the actual behaviour —
clearing the path triggers the sentinel placeholder, and branch selection
is determined by `cycle_count` and `had_addendum_originally`.

### W2 — `arbitrationAddendumPath` allowlist rejection no longer downgrades Branch 3 to Branch 2

Previously, when `addendum_path` failed the allowlist, it was cleared to
`""`. The branch selector then fired Branch 2 (no-addendum revision) even
though the server reported `arbitrationAddendumPath` non-null. The engineer
would never see the arbitration ruling and could re-apply retired findings
or re-trigger the contradiction.

Fix mirrors the cycle-1 `latest_review_path` sentinel pattern:

1. Capture `had_addendum_originally=1` BEFORE the allowlist scrub when the
   server reported a non-null addendum.
2. On allowlist failure, clear `addendum_path` but also set
   `addendum_rejected=1`.
3. The branch selector at line 233 was changed from
   `elif [ -z "$addendum_path" ]` to
   `elif [ "$had_addendum_originally" = "0" ]` — Branch 3 fires whenever
   the server reported a non-null addendum, regardless of allowlist verdict.
4. In Branch 3, a new `addendum_display` variable carries either the valid
   path, the rejected-path sentinel, or a defensive "missing" sentinel.

A legitimately-null server addendum (no arbitration has happened) leaves
`had_addendum_originally=0` and routes to Branch 2 with no bogus sentinel,
as required by the plan.

### Changes

- **`container/lib/run-claude.sh`** — `_build_engineer_prompt` only:
  - Added `had_addendum_originally` and `addendum_rejected` flag locals
    initialised to 0 (W2).
  - Set `had_addendum_originally=1` after the `jq -r` extraction of
    `addendum_path`, before any allowlist work, when the path is
    non-empty (W2).
  - Set `addendum_rejected=1` (in addition to clearing `addendum_path`)
    when the allowlist check fails on addendum (W2).
  - Updated the allowlist-block comment from the misleading cycle-0
    wording to text that names the actual sentinel routing and
    branch-selection drivers (W1).
  - Updated the WARNING message on addendum allowlist failure to mention
    the post-arbitration branch + sentinel placeholder (W2).
  - Changed the branch selector from
    `elif [ -z "$addendum_path" ]` to
    `elif [ "$had_addendum_originally" = "0" ]` (W2).
  - Added Branch 3 `addendum_display` derivation (rejected sentinel
    vs defensive missing sentinel vs valid path) (W2).
  - Added explanatory comments on Branch 2 and Branch 3 noting the
    new branch-selection contract (W1 / W2 documentation).
- **Env-fallback path** — `had_addendum_originally` stays 0, correctly
  routing to Branch 1 / Branch 2 only (no server state, never claim a
  rejected addendum).
- No changes to `dynamic-agents/container-implementer-ue.md` or its
  compiled outputs — both findings are in the prompt-builder shell only.

### Build & Test Results — Cycle 2

- `bash -n container/lib/run-claude.sh` — clean.

### Branch re-trace for all requested scenarios

The legend `cN` = `cycle_count=N`, `lrp` = `latest_review_path`,
`add` = `addendum_path`, `had_add` = `had_addendum_originally`.

**(a) Valid inputs**

| input                              | branch | rendered |
|------------------------------------|--------|----------|
| c0, source_path="plans/x.md"       | 1      | `${source_path}=plans/x.md` |
| c2, lrp="r.md", add=""             | 2      | `${lrp_display}=r.md` |
| c2, lrp="r.md", add="a.md"         | 3      | `${lrp_display}=r.md`, `${addendum_display}=a.md` |

**(b) latestReviewPath rejected by allowlist**

| input                              | branch | rendered |
|------------------------------------|--------|----------|
| c2, lrp=`$(evil)`, add=""          | 2      | `${lrp_display}=<latestReviewPath missing — refetch GET /tasks/${task_id}>` |
| c2, lrp=`$(evil)`, add="a.md"      | 3      | `${lrp_display}=<latestReviewPath missing>`, `${addendum_display}=a.md` |

**(c) addendum_path rejected by allowlist**

| input                              | branch | rendered |
|------------------------------------|--------|----------|
| c2, lrp="r.md", add=`$(evil)`      | 3      | `${lrp_display}=r.md`, `${addendum_display}=<arbitrationAddendumPath rejected — refetch GET /tasks/${task_id}>` |

(Branch 3 fires because `had_add=1`, even though post-scrub `add=""`.)

**(d) Both rejected**

| input                              | branch | rendered |
|------------------------------------|--------|----------|
| c2, lrp=`$(a)`, add=`$(b)`         | 3      | `${lrp_display}=<latestReviewPath missing>`, `${addendum_display}=<arbitrationAddendumPath rejected — refetch GET /tasks/${task_id}>` |

**(e) Addendum legitimately null (no arbitration yet)**

| input                              | branch | rendered |
|------------------------------------|--------|----------|
| c2, lrp="r.md", add=""             | 2      | `${lrp_display}=r.md` — no addendum sentinel (correct) |

All five scenarios produce the contractually-correct branch and sentinel.

