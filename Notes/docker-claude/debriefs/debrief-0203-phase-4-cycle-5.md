# Debrief 0203 — Phase 4 cycle 5: stop-file guard in pause-loop helper

## Task Summary

Phase 4 cycle 5 of the durable-task FSM rework. The safety reviewer raised one
WARNING on commit d889289 (cycle 4) noting that `_wait_while_paused` in
`container/lib/pump-loop.sh` polls server-side agent status for the
`paused → stopping` transition but does not check the `/tmp/.stop_requested`
sentinel that `run-claude.sh:268` uses as the SIGTERM stop-signal hook. A direct
SIGTERM bypassing the dashboard's pause→stop status flip would not be observed
by the helper for up to one `WORKER_POLL_INTERVAL` (default 30s).

The instructions explicitly noted this is a pre-existing gap that the cycle 4
refactor merely surfaced, not a regression. Fix per safety reviewer's suggested
patch, plus the `:-30` defensiveness on the `sleep` value.

The task also flagged two sibling `sleep` sites in `_poll_and_claim_task` that
have the same gap, with a path-(a)/path-(b) decision to make based on the size
of the additional fix.

## Changes Made

- **container/lib/pump-loop.sh** — modified.
  - `_wait_while_paused`: added `[ -f /tmp/.stop_requested ]` check at the top
    of the loop body (returns 1 if the sentinel exists), and changed
    `sleep "$WORKER_POLL_INTERVAL"` to `sleep "${WORKER_POLL_INTERVAL:-30}"` so
    an unset variable defaults to 30s instead of the bash-default 0s spin.
  - Updated the helper's doc-comment to document both the new return-1 path on
    `/tmp/.stop_requested` and the rationale (SIGTERM bypassing the
    pause→stop status flip).
  - `_poll_and_claim_task`, HTTP-failure branch (claim-next request returned
    non-200): added the same `/tmp/.stop_requested` guard before the sleep,
    setting `ABNORMAL_SHUTDOWN="stop_requested"` and `exit 0` to match the
    function's existing `stopping`-detection contract at the top of the loop.
    Same `:-30` defensiveness.
  - `_poll_and_claim_task`, no-claimable-task branch (pending > 0 but no
    claimable row): same guard, same `:-30`.

## Design Decisions

**Path (b): patched all three sleep sites.** The instructions left this open:
path (a) was minimum scope (helper only); path (b) was patch all three for
consistency. The two sibling sleeps were small one-line additions of the same
pattern (a guarded check followed by `exit 0` with `ABNORMAL_SHUTDOWN`). No
restructuring was needed; the `_poll_and_claim_task` function already exits
the same way at line 339 when `_get_agent_status` returns `stopping`, so the
new exits sit alongside an existing precedent and use the same enum value
(`stop_requested`). The cost was three identical four-line blocks; the benefit
is that the stop-file sentinel is honored uniformly across every blocking sleep
in the pump module. Mixing guarded and unguarded sleeps would be a smell.

**Exit semantics for the claim-loop guards.** I chose `exit 0` (not `return 1`)
for both new claim-loop guards, mirroring the function's existing
`stopping`-detection branch at line 337-341. The pump driver (`pump-loop.sh` is
called from `entrypoint.sh` via the outer pump driver) treats `stop_requested`
ABNORMAL_SHUTDOWN as a clean termination signal, and the existing branch
predates this fix — preserving the same exit shape avoids introducing a third
shutdown path here. `_wait_while_paused` keeps its `return 1` contract because
its single caller (`_pump_iteration` at line 492) already translates `return 1`
into `PUMP_STATUS="stop"` and an orderly return.

**`:-30` defensiveness.** Applied to all three `sleep` invocations because the
reviewer asked for it on the helper; for consistency, the sibling sleeps got
the same treatment in the same commit. No script in the entrypoint chain
unsets `WORKER_POLL_INTERVAL` after `env.sh` sets it, but the guard costs
nothing and prevents a hypothetical 100% CPU spin if `set -u` is dropped or
the variable is later cleared in a refactor.

**Doc-comment update.** Bumped the `_wait_while_paused` header comment to
document the new return-1 path. The claim-loop guards did not need separate
doc updates because the function-level comment at line 332-334 already covers
its stop-detection contract; the new guards are an extension of that.

## Build & Test Results

- `bash -n /workspace/container/lib/pump-loop.sh` → **OK** (clean syntax).
- No server tests touched — change is shell-only and timing-dependent, as
  the task brief specified. No JS/TS code was modified, so no `npm run build`
  or `npm test` cycle was needed.

## Open Questions / Risks

- The new claim-loop guards run **after** `_post_status "idle"` (the no-task
  branch). If the operator-initiated stop arrives between that POST and the
  guard, the agent will momentarily report `idle` before exiting. This matches
  the prior behavior (the existing `stopping`-status check at the top of the
  loop has the same window) and is not worth restructuring for.
- The guard placement in the HTTP-failure branch is **before** `continue` and
  **after** the `echo`. If the server is down hard, the agent will log
  "request failed" once per `WORKER_POLL_INTERVAL` until either the server
  recovers or the operator drops the sentinel. Acceptable; the alternative
  (silent retry-loop on stop-pending) is worse.

## Suggested Follow-ups

- None essential. If a future phase adds another blocking sleep in the pump
  module, the same guard pattern should be replicated — consider extracting a
  `_check_stop_or_sleep` helper at that point. Premature today (only three
  call sites, each in a different control-flow context).
