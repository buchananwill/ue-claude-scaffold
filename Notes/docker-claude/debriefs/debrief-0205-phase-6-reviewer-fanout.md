# Debrief 0205 — Phase 6: Parallel reviewer dispatch and mechanical consolidation

## Task Summary

Implement Phase 6 of the durable-task FSM plan (`plans/durable-task-fsm-and-parallel-role-sessions/phase-6-…md`):

- New `container/lib/reviewer-fanout.sh` that orchestrates parallel per-reviewer dispatch when the daisy-chain enters `built` / `reviewing`.
- Wire the `DAISY_CHAIN_ROLE=reviewer-fanout` dispatch seam in `container/lib/run-claude.sh` so that branch hands off to `_run_reviewer_fanout` and skips the normal top-level claude invocation.
- Remove the `reviewer-fanout` arm of the `arbitrator | reviewer-fanout` stub in `container/lib/pump-loop.sh`.
- Source `reviewer-fanout.sh` from `container/entrypoint.sh` alongside the other `lib/*.sh` modules.
- Collapse the BLOCKING/WARNING/NOTE three-tier severity scheme to BLOCKING/NOTE in `skills/review-output-schema/SKILL.md`, drop the orchestrator-blocking-warning rule, and add a JSON-shadow-block specification consumed by `POST /tasks/:id/reviews`.
- Sweep the three reviewer agent definitions (`dynamic-agents/container-{safety,decomposition,reviewer}-reviewer-ue.md`) for any `WARNING` references — none present.

## Changes Made

| File | Action | Description |
|---|---|---|
| `container/lib/reviewer-fanout.sh` | created | Phase 6 fanout module: built→reviewing entry, recovery skip, parallel scoped reviewer spawn with atomic .tmp→.md rename, retry budget (2 retries → reviewer_infrastructure_failure), per-role verdict-merge self-loops, alphabetical consolidated.md concatenation, final complete/revising transition. |
| `container/lib/run-claude.sh` | modified | Added `DAISY_CHAIN_ROLE=reviewer-fanout` short-circuit in `_run_claude` that dispatches to `_run_reviewer_fanout` and returns its exit code without invoking the top-level dangerously-skip-permissions claude. |
| `container/lib/pump-loop.sh` | modified | Removed `reviewer-fanout` from the stub arm; left `arbitrator` stubbed for Phase 7. |
| `container/entrypoint.sh` | modified | Added `source ${SCRIPT_DIR}/lib/reviewer-fanout.sh` immediately before `lib/run-claude.sh` (run-claude.sh references `_run_reviewer_fanout`, so reviewer-fanout must be sourced first). |
| `skills/review-output-schema/SKILL.md` | rewritten | Replaced WARNING tier with NOTE tier; renumbered IDs (B*, N* — no W*); rewrote confidence rubric as two-tier (≥75% BLOCK, 50-89% NOTE, <50% omit); replaced verdict rule (only BLOCKING blocks); replaced orchestrator-blocking sentence with NOTE-is-observability rule; added JSON shadow block spec mirroring `POST /tasks/:id/reviews` body. Spec-Fidelity Finding Resolution section unchanged. |
| `dynamic-agents/container-{safety,reviewer,decomposition}-reviewer-ue.md` | unchanged | Confirmed via `grep -n WARNING` — no occurrences. Sweep is a no-op as predicted by the task description. |

## Design Decisions

1. **Review cycle vs daisy-chain cycle.** The `cycle` arg passed to `_run_reviewer_fanout` from the daisy-chain is the loop counter, not the FSM `reviewCycleCount`. The fanout fetches `reviewCycleCount` itself and uses that for both the `.scratch/reviews/<task-id>/cycle-<N>/` path and the `POST /tasks/:id/reviews` cycle field. Keying on the daisy-chain counter would diverge across `revising → engineering → built → reviewing` revolutions; keying on the server's `reviewCycleCount` matches Phase 2's "reset reviewerVerdicts on built→reviewing" semantics.

2. **Retry budget arithmetic.** "Up to 2 retries" → 3 total spawn attempts (1 initial + 2 retries). The counter increments after each iteration that includes the role in `spawn_set`; the budget guard at the top of the next iteration trips when `retries > 2`. Tested mentally: iter 1 spawns, retries=1; iter 2 spawns, retries=2; iter 3 spawns, retries=3; iter 4 guard fires before spawning, posts `reviewer_infrastructure_failure`.

3. **Recovery skip uses server-side rows.** The authoritative success signal is a row in `review_runs`, not the claude subprocess exit code. A reviewer that crashes mid-POST may have written a `.md` file but never persisted; conversely, a reviewer that POSTed and then crashed before normal exit would still be considered successful. Re-reading `/tasks/:id/reviews/:cycle` at the top of every fanout iteration is the only correct dedupe key.

4. **Per-role verdict merges happen after all rows are present.** I post the `reviewing → reviewing` self-loop merges only after the spawn loop has confirmed every declared reviewer has a `/reviews` row. This means on a recovery re-entry where some roles already POSTed and merged, we'll re-post the same merge — Phase 2 says this is idempotent for unchanged verdict values. Flagging as a minor inefficiency, not a correctness issue.

5. **Built→reviewing transition skipped on recovery.** When the fanout enters with `status='reviewing'` (recovery path), I do NOT re-post `built → reviewing` because that transition resets `reviewerVerdicts` to `{}`. Doing so would clobber any verdict merges already accumulated by partially-completed reviewers.

6. **Empty reviewers map.** Per Phase 6 step 8, "A task that runs zero reviewers is currently invalid". The fanout fails with `role_session_no_op` rather than silently transitioning to `complete`. The Phase 1 schema is supposed to enforce this, but the fanout is the failsafe.

7. **Consolidated.md sort order.** `LC_ALL=C sort` for stable byte-order alphabetical sort across locales (C locale sorts by ASCII codepoint, so `correctness < decomp < safety` regardless of host locale).

8. **Where to source reviewer-fanout.sh.** Sourced from `entrypoint.sh` immediately before `run-claude.sh`. Order matters: `run-claude.sh`'s `_run_claude` calls `_run_reviewer_fanout`, so the latter must already be in scope. Did not modify any other line in entrypoint.sh.

## Build & Test Results

- `bash -n` on all four shell files (`reviewer-fanout.sh`, `run-claude.sh`, `pump-loop.sh`, `entrypoint.sh`): pass.
- `cd server && npm run typecheck`: pass (no new TS code, but verifies adjacent code remains clean).
- `npx tsx --test src/routes/reviews.test.ts`: 29/29 pass.
- `npx tsx --test src/routes/tasks-lifecycle.test.ts`: 45/45 pass.

No build failures; no test failures. Container-side shell isn't unit-tested in this repo, so verification is by syntax check + plan-fidelity review.

## Open Questions / Risks

1. **Reviewer cannot POST /reviews via curl under the literal allowlist.** ~~Phase 6 step 3 specifies the reviewer's `--allowed-tools` as `Read,Grep,Glob,Bash(git diff:*,git log:*,wc:*,ls:*)` — which excludes `curl`. Phase 6 step 4 instructs the reviewer "Your last action before exiting is to POST your verdict and findings to ${SERVER_URL}/tasks/<task-id>/reviews".~~

   **Resolved (cycle 0a):** the orchestrator adjudicated the spec contradiction and chose option (a) from this entry — extend the reviewer allowlist with `Bash(curl:*)`. Rationale: Phase 6's acceptance criterion only requires that `Write` and `Edit` be rejected; curl POSTs to the in-cluster coordination server are not source-file edits and are consistent with the "reviewer cannot modify source code" intent. The reviewer prompt's "## Tool scope" section was updated in lockstep to list curl alongside the other narrow Bash entries, with a one-line note that it is permitted solely for the final POST. Risk closed.

2. **Daisy-chain cycle vs review cycle naming.** The pump-loop's `_run_role_session` writes its log under `.scratch/reviews/<task-id>/cycle-<daisy-chain-cycle>/reviewer-fanout.log` while my fanout writes its per-role and consolidated files under `.scratch/reviews/<task-id>/cycle-<review-cycle>/`. These two `cycle-N` directories may differ on a recovery re-entry. Acceptable for now (different filenames within either dir), but a future refactor should align on a single cycle key.

3. **`_run_role_session` builds and discards a generic prompt for fanout.** Pump-loop calls `_build_task_prompt` and passes it into `_run_claude` even on the fanout path. `_run_claude` then ignores the prompt entirely and dispatches to `_run_reviewer_fanout`. Wasted work but cheap (one `jq` invocation per cycle); not worth a special case in pump-loop given the dispatcher already special-cases engineer the same way.

## Suggested Follow-ups

- Add `Bash(curl:*)` to the reviewer allowlist OR add an MCP tool that proxies POST /reviews — required to make the reviewer flow actually function (see Risk 1).
- Add an integration test that drives `_run_reviewer_fanout` against a stub coordination server (PGlite + Fastify in-process) to verify recovery-skip, retry-budget, and consolidated.md byte-equality. Currently only the typescript route tests cover the server side.
- The `orchestrator-phase-protocol` skill (not in this phase's file ownership) still references `BLOCKING and WARNING` in three places (`skills/orchestrator-phase-protocol/SKILL.md:61, 111, 190-196`). It will need a similar sweep when its mandate is unscoped.
