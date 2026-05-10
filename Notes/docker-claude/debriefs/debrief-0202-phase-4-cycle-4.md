# Debrief 0202 — Phase 4 cycle 4: extract daisy-chain helpers

## Task Summary

Address three WARNING (no BLOCKING) decomposition findings against
`container/lib/pump-loop.sh` from the cycle-3 review:

- **W1:** hardcoded FSM-status string in `_resume_in_flight_tasks` duplicates
  `ACTIVE_STATUSES` from `server/src/queries/query-helpers.ts`, with no
  documented rationale for the divergence (`claimed` is omitted from the
  probe).
- **W2:** the same `role_session_no_op` failure-transition payload is built
  inline at two call sites (`_run_daisy_chain` and `_pump_iteration`).
- **W3:** two near-identical agent-status pause/resume polling loops in
  `_poll_and_claim_task` and at the tail of `_pump_iteration`.

## Changes Made

- **`container/lib/pump-loop.sh`** — modified
  - Added cross-reference comment on `_role_for_status` pointing to
    `ACTIVE_STATUSES` in `query-helpers.ts` and to the `tasks_status_check`
    schema constraint, naming the lockstep contract.
  - Added cross-reference comment on the `_resume_in_flight_tasks` probe
    explaining *why* `claimed` is excluded (no in-progress work to resume; the
    normal claim path picks it up; listing it would race and double-process).
  - Extracted `_post_role_session_no_op task_id detail` (W2). Both the
    daisy-chain mid-loop call site and the agent-type-fetch failure branch in
    `_pump_iteration` now go through this single seam. Phase 8's failure-
    reason aggregator gets one place to wire structured logging.
  - Extracted `_get_agent_status` (W3 helper 1). Used by both the claim-loop
    stop-detection probe and the post-iteration pause/stop probe. Echoes
    `unknown` on any error, matching the prior inline behaviour.
  - Extracted `_wait_while_paused` (W3 helper 2). Used only by
    `_pump_iteration`'s tail (the post-iteration variant). The claim-loop
    probe deliberately does not call this — its poll-sleep already absorbs
    pause naturally, and blocking there would be redundant. Documented this
    intentional asymmetry in the helper's docblock and at the claim-loop
    probe site.

## Design Decisions

**W1 — option 3 (documentation cross-reference).** The user explicitly
recommended this over the new-endpoint option, on the grounds that the cross-
language duplication is structural to the scaffold (shell calls server) and
not unique to this phase. The change is two comment blocks; no new route, no
new contract, no test surface to maintain. The orphan-literal check
(`grep -n active_statuses container/lib/pump-loop.sh`) returns only the two
lines of the legitimate single use site, immediately preceded by the rationale
comment.

**W2 — straightforward extraction.** The two original call sites had
identical jq payloads and `_curl_server` invocations. The extracted helper
preserves the swallow-on-error contract (`>/dev/null 2>&1 || true`) so neither
call site changes behaviour: a failed POST leaves the task in its current
state and the next iteration detects it.

**W3 — preserved the asymmetry the reviewer flagged.** The two original
loops were not actually identical: the claim-loop probe only acts on
`stopping` (it does not block on `paused`, because the per-iteration sleep
already does), while the post-iteration block blocks on `paused` until the
agent resumes. Rather than flatten this into a single unified helper that
does both jobs, I extracted two small helpers: `_get_agent_status` (the
shared curl/jq plumbing — used by both sites) and `_wait_while_paused` (the
post-iteration-only blocking variant). The claim-loop probe consumes only
`_get_agent_status` and remains structurally distinct from the pause/resume
logic. The asymmetry is now explicit in two docblocks and a comment, rather
than implicit in two near-identical-but-not-quite loops.

## Build & Test Results

- `bash -n /workspace/container/lib/pump-loop.sh` — passes.
- Server test suite — `npm test` from `server/`: 737 tests, 683 pass, 54
  fail, exit 0. No server code changed in this cycle (only
  `container/lib/pump-loop.sh`), so I confirmed by stashing the change and
  re-running on the prior commit `62b3d3d` (Phase 4 cycle 3): identical
  results — 737 / 683 / 54 / exit 0. The 54 failures are pre-existing and
  unrelated to this cycle. The npm script returns 0 despite the failure
  count, which is why the suite was previously reported as passing; that is
  also a pre-existing condition. Flagged as a follow-up risk below; this
  cycle adopts the same baseline as cycle 3 for parity.
- W1 option 3 (documentation) was selected, so no new endpoint was added and
  no new route test was needed.

## Open Questions / Risks

- The `_get_agent_status` helper's fallback (`|| echo "unknown"`) is a
  defence-in-depth: jq will already substitute `"unknown"` via `// "unknown"`
  on a missing field, but a curl failure to even produce stdout could cause jq
  to emit empty. The trailing `|| echo "unknown"` covers that case. The two
  prior inline forms had similar `|| agent_status="unknown"` fallbacks, so
  this is behaviour-preserving.
- The single-seam `_post_role_session_no_op` is intentionally fire-and-forget
  (`>/dev/null 2>&1 || true`). If Phase 8's failure-reason aggregator later
  needs to know whether the POST succeeded, the helper will need a return-
  code contract — but that change is out of scope for this cycle.

## Suggested Follow-ups

- The server `npm test` script reports 54 failures in the TAP output but
  exits 0. Some prior cycle should investigate whether this is the TAP
  reporter's intentional behaviour or a misconfigured exit-code propagation;
  if the latter, fixing it would reveal real regressions sooner. Not in
  scope for cycle 4.

- When Phase 8 lands the failure-reason aggregator, wire structured logging
  through `_post_role_session_no_op`. The single seam was created with that
  use case explicitly in mind.
- If the FSM ever grows or shrinks an active-state, consider a startup-time
  consistency check: have the container fetch a hypothetical
  `GET /tasks/active-statuses` (or expose the set on `GET /health`) and
  cross-check against the `_role_for_status` case statement, logging a
  warning on divergence. This was W1 option 1 and was not selected for this
  cycle, but the failure mode (silent skew between TS and bash) remains.
