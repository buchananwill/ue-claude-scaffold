# Engineer Session Continuity and Inline Review Transport

## Goal

Replace the current spin-down-and-respawn cycle with a continuous engineer session: when the engineer finishes an implementation chunk it calls a blocking script that requests review, blocks until the verdict lands, and either receives consolidated findings to revise from (continuing in the same session), an "approved" signal to exit cleanly, or — after the 5th cycle — an arbitrator's verdict. Mirrors the [build/test transport](../container/hooks/forward_build_test.sh) so the engineer experiences "no passage of time" across review cycles.

## Context

- Per-cycle review machinery (`POST /tasks/:id/reviews`, `review_runs`, `review_findings`, [classifyReview](../server/src/review-decision.ts)) stays intact — this plan extends, never replaces.
- Reviewer subprocess claudes run inline in the engineer's own container. The server orchestrates FSM transitions and the accept/revise/arbitrate decision; it does not spawn claude processes itself.
- The existing per-role spawn logic in [container/lib/reviewer-fanout.sh](../container/lib/reviewer-fanout.sh) and [container/lib/arbitrator-dispatch.sh](../container/lib/arbitrator-dispatch.sh) is factored into sourced helpers shared by both the new transport script (happy path) and the existing daisy-chain ([container/lib/pump-loop.sh](../container/lib/pump-loop.sh)) (recovery path).
- The FSM and `classifyReview` predicates defined in [server/src/routes/tasks-lifecycle.ts](../server/src/routes/tasks-lifecycle.ts) and [server/src/review-decision.ts](../server/src/review-decision.ts) are authoritative; the new endpoints call them rather than re-deriving any logic.
- Arbitration trigger is `classifyReview === "revise"` AND `reviewCycleCount >= 5`, evaluated at finalize-time. The `reviewCycleCount` column on `tasks` is the canonical cycle counter and is incremented exactly once per request-review entry.
- Recovery is preserved unchanged: a fresh container resuming a task at any FSM mid-state reads `tasks.status` and dispatches the appropriate role via the existing daisy-chain in [container/lib/pump-loop.sh](../container/lib/pump-loop.sh). The new continuous-engineer flow is a happy-path optimization, not a replacement for recovery dispatch.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Server endpoint `POST /tasks/:id/request-review`

**Outcome:** A task in status `engineering` or `revising`, when this endpoint is called, atomically transitions through to `reviewing`, increments `tasks.reviewCycleCount` by exactly one, and the response body contains the resolved reviewers map plus the new cycle number. Re-calling the endpoint with the same task and same cycle is idempotent (no double-increment).

**Types / APIs:**

```ts
// Request body
interface RequestReviewBody {
  // Optional retry guard. If supplied, the endpoint returns the existing
  // cycle's response without incrementing if reviewCycleCount already equals
  // expectedCycle. Omitted on first call.
  expectedCycle?: number;
}

// Response body
interface RequestReviewResponse {
  cycle: number;                       // == new tasks.reviewCycleCount
  reviewers: Record<string, string>;   // role → agent basename, from
                                       // effective agentRoles (project + override)
}
```

Endpoint: `POST /tasks/:id/request-review` (route file: `server/src/routes/request-review.ts`).

Status codes: 200 on success, 400 on illegal source status (current status not in {`engineering`, `revising`, `reviewing`}), 404 on task not found, 409 on `expectedCycle` mismatch.

**Work:**

- Create new file [server/src/routes/request-review.ts](../server/src/routes/request-review.ts) as a `FastifyPluginAsync` (matches the existing route file convention).
- Register the plugin in [server/src/server.ts](../server/src/server.ts) alongside the other task route plugins.
- Resolve the effective reviewers map by reading `projects.<id>.agentRoles.reviewers` from the project config (via `resolveProject` in [server/src/resolve-project.ts](../server/src/resolve-project.ts)) and shallow-merging `tasks.agentRolesOverride.reviewers` on top, mirroring `_resolve_roles_for_task` in [container/lib/pump-loop.sh](../container/lib/pump-loop.sh).
- In a single transaction:
  - Read `tasks` row by `(id, projectId)`. 404 if missing.
  - Validate current `status` is one of `engineering`, `revising`, or `reviewing`. 400 otherwise.
  - If `status === "reviewing"` AND `expectedCycle` is supplied AND equals current `reviewCycleCount`: return the resolved reviewers map and current cycle without further changes (idempotent re-entry).
  - Otherwise: apply transitions `engineering → built → reviewing` or `revising → engineering → built → reviewing` by calling `tasksLifecycleQ.applyTransition` in sequence (the FSM table in [server/src/routes/tasks-lifecycle.ts](../server/src/routes/tasks-lifecycle.ts) already permits each step). Increment `reviewCycleCount` as part of the final `reviewing` transition's `TransitionUpdate`.
- Return `{cycle, reviewers}`.

**Verification:** New test file [server/src/routes/request-review.test.ts](../server/src/routes/request-review.test.ts) using `drizzle-test-helper.ts`. Cases:
- `engineering → reviewing` happy path: response cycle is 1, status row is `reviewing`, reviewers map matches the resolved set.
- `revising → reviewing` happy path: cycle increments by 1, status row is `reviewing`.
- `expectedCycle` matches current `reviewCycleCount` and status is already `reviewing`: response is identical, no row mutation.
- `expectedCycle` mismatches: 409.
- Illegal source status (e.g., `claimed`, `built`, `completed`): 400.
- Unknown task: 404.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Server endpoint `POST /tasks/:id/finalize-review-cycle`

**Outcome:** A task in status `reviewing` with all declared reviewers' `review_runs` rows present for the current cycle is transitioned to one of `completed`, `engineering` (via `revising`), or `arbitrating`, based on `classifyReview` and the cycle counter. The response is a discriminated union describing the verdict.

The arbitration trigger fires when `classifyReview` returns `"revise"` AND `tasks.reviewCycleCount >= 5`. At that point the endpoint posts `reviewing → arbitrating` and returns the arbitrator agent basename for the caller to spawn.

**Types / APIs:**

```ts
interface ConsolidatedFinding {
  reviewerRole: string;
  severity: "BLOCKING" | "NOTE";
  title: string;
  filePath: string | null;
  line: number | null;
  description: string;
  evidence: string | null;
  fix: string | null;
}

type FinalizeReviewCycleResponse =
  | { decision: "accept" }
  | { decision: "revise"; cycle: number; findings: ConsolidatedFinding[] }
  | { decision: "arbitrate"; arbitrator: string; trigger: "review_cycle_budget_exhausted" };
```

Endpoint: `POST /tasks/:id/finalize-review-cycle` (added to the same route file as Phase 1).

Status codes: 200 on success, 400 on illegal source status (not `reviewing`), 404 on task not found, 409 if any declared reviewer has not posted a `review_runs` row for the current cycle.

**Work:**

- Add the handler to [server/src/routes/request-review.ts](../server/src/routes/request-review.ts).
- In a single transaction:
  - Read `tasks` row. 404 if missing. 400 if status is not `reviewing`.
  - Resolve declared reviewer roles (same merge as Phase 1).
  - Call `tasksLifecycleQ.getReviewerAggregates(taskId, cycle)` where `cycle === tasks.reviewCycleCount`. If the row count is less than the declared role count, 409 with body `{error: "reviewers incomplete", missing: string[]}`.
  - Call [classifyReview](../server/src/review-decision.ts).
  - On `"accept"`: apply `reviewing → completed`. Return `{decision: "accept"}`.
  - On `"revise"` with `reviewCycleCount < 5`: apply `reviewing → revising → engineering` (two transitions in one transaction). Fetch all `review_findings` for the current cycle, shape into `ConsolidatedFinding[]` ordered by reviewerRole then ordinal. Return `{decision: "revise", cycle: <current>, findings}`.
  - On `"revise"` with `reviewCycleCount >= 5`: apply `reviewing → arbitrating`, setting `tasks.arbitrationPendingTrigger = "review_cycle_budget_exhausted"`. Resolve `agentRoles.arbitrator` from the project config (404 if absent). Return `{decision: "arbitrate", arbitrator: <basename>, trigger: "review_cycle_budget_exhausted"}`.

**Worked example — arbitration threshold:**

Scenario: an engineer has just completed its 5th review cycle (`reviewCycleCount === 5`). The reviewers' aggregates produce `classifyReview === "revise"`.

Trace: the finalize handler reads `reviewCycleCount === 5`. The check `decision === "revise" && reviewCycleCount >= 5` evaluates as `true && (5 >= 5)` → `true`. The handler posts `reviewing → arbitrating` and returns the arbitrate response. The engineer never sees a 6th review cycle.

Counter-trace: same scenario but `reviewCycleCount === 4`. The check is `true && (4 >= 5)` → `false`. The handler falls into the `"revise"` under-budget branch and returns findings for the engineer's 5th cycle.

If the implementation produces the opposite outcome from either trace, the threshold has been inverted (`<` instead of `>=`, or `reviewCycleCount` shifted by one). Fix at the predicate, not by tweaking the constant.

**Verification:** Extend [server/src/routes/request-review.test.ts](../server/src/routes/request-review.test.ts):
- Accept happy path: status row ends `completed`.
- Revise under budget (cycle 1–4): status row ends `engineering`, response contains findings shaped from `review_findings` rows.
- Revise at cycle 5: status row ends `arbitrating`, response contains arbitrator basename, `arbitrationPendingTrigger === "review_cycle_budget_exhausted"`.
- Missing reviewer: 409.
- Illegal source status (e.g., `engineering`): 400.

<!-- PHASE-BOUNDARY -->

## Phase 3 — Server endpoint `POST /tasks/:id/finalize-arbitration`

**Outcome:** A task in status `arbitrating` with an `arbitration_runs` row for the current trigger is transitioned to `completed` (on arbitrator override-approve) or `failed` with reason `arbitrator_escalated` (on arbitrator escalate), and the verdict is returned to the caller.

**Types / APIs:**

```ts
type FinalizeArbitrationResponse =
  | { decision: "accept"; overrideNote: string }
  | { decision: "escalate"; reason: string };
```

Endpoint: `POST /tasks/:id/finalize-arbitration` (added to the same route file).

Status codes: 200 on success, 400 on illegal source status (not `arbitrating`), 404 on task not found, 409 if no `arbitration_runs` row exists for the task's current `arbitrationPendingTrigger`.

**Work:**

- Add the handler to [server/src/routes/request-review.ts](../server/src/routes/request-review.ts).
- In a single transaction:
  - Read `tasks` row. 404 if missing. 400 if status is not `arbitrating`.
  - Look up the latest `arbitration_runs` row matching `(taskId, trigger === tasks.arbitrationPendingTrigger)`. 409 if absent.
  - Inspect the row's `verdict` field:
    - `"override_approve"`: apply `arbitrating → completed`. Return `{decision: "accept", overrideNote: <row.notes>}`.
    - `"escalate"`: apply `arbitrating → failed` with `failureReason === "arbitrator_escalated"` and `failureDetail === <row.notes>`. Return `{decision: "escalate", reason: <row.notes>}`.

**Verification:** Extend [server/src/routes/request-review.test.ts](../server/src/routes/request-review.test.ts):
- Override-approve outcome: status row ends `completed`, response carries note.
- Escalate outcome: status row ends `failed`, `failureReason === "arbitrator_escalated"`.
- No `arbitration_runs` row: 409.
- Illegal source status: 400.

<!-- PHASE-BOUNDARY -->

## Phase 4 — Extract reviewer and arbitrator spawn helpers

**Outcome:** The per-role spawn logic currently embedded in [container/lib/reviewer-fanout.sh](../container/lib/reviewer-fanout.sh) and [container/lib/arbitrator-dispatch.sh](../container/lib/arbitrator-dispatch.sh) is moved into a new sourced helper file so both the legacy daisy-chain (recovery) and the new transport script (happy path) call the same code.

**Types / APIs:**

New file: `container/lib/inline-spawn-helpers.sh`.

Exposed functions (all sourced into the container's bash environment via [container/entrypoint.sh](../container/entrypoint.sh)):

```bash
# Spawn one reviewer subprocess. Returns 0 on a successful claude exit and
# atomic rename of <role>.md.tmp → <role>.md; non-zero otherwise.
# Args: task_id, cycle, role, agent_basename, source_path, files_csv,
#       task_title, scratch_dir.
_inline_spawn_reviewer ...

# Spawn one arbitrator subprocess. Returns 0 on a successful claude exit and
# successful POST of the arbitration_runs row; non-zero otherwise.
# Args: task_id, trigger, agent_basename, source_path, files_csv,
#       task_title, scratch_dir.
_inline_spawn_arbitrator ...
```

The function names are the canonical entry points; the existing `_rfan_spawn_reviewer` and the arbitrator spawn block in [container/lib/arbitrator-dispatch.sh](../container/lib/arbitrator-dispatch.sh) become thin wrappers that call these.

**Work:**

- Create [container/lib/inline-spawn-helpers.sh](../container/lib/inline-spawn-helpers.sh) and lift the prompt-building + claude-invocation code from `_rfan_spawn_reviewer` ([container/lib/reviewer-fanout.sh](../container/lib/reviewer-fanout.sh) line 163 onward) and the corresponding arbitrator block in [container/lib/arbitrator-dispatch.sh](../container/lib/arbitrator-dispatch.sh).
- Source the new helper from [container/entrypoint.sh](../container/entrypoint.sh) alongside the existing `reviewer-fanout.sh` and `arbitrator-dispatch.sh` sources.
- Replace the in-place spawn code in [container/lib/reviewer-fanout.sh](../container/lib/reviewer-fanout.sh) and [container/lib/arbitrator-dispatch.sh](../container/lib/arbitrator-dispatch.sh) with calls to the new functions. Keep the surrounding orchestration (retry loops, fanout coordination) where it is.
- Preserve the existing security posture: the same allowlist-scrub of `task_title`, `source_path`, `files_csv` happens before calling either helper; the same `_is_safe_name` checks on `role` and `agent_basename`; the same scoped tool list passed to `claude --allowed-tools`.

**Verification:**
- `bash -n container/lib/inline-spawn-helpers.sh` parses clean.
- `bash -n container/lib/reviewer-fanout.sh` and `bash -n container/lib/arbitrator-dispatch.sh` still parse clean after the substitutions.
- No behavior change to the daisy-chain recovery path — exercise by re-running any existing container-side tests that touched reviewer-fanout (if none, mark as manual verification: launch a container, force a recovery from `reviewing` status, observe reviewers spawn as before).

<!-- PHASE-BOUNDARY -->

## Phase 5 — Container script `container/scripts/request-review.sh`

**Outcome:** A self-contained script that the engineer invokes as a blocking call. It commits and pushes the working tree, drives the three new server endpoints, spawns reviewer subprocesses inline, optionally spawns the arbitrator inline, and prints a single structured JSON response on stdout. The engineer's claude session reads that JSON and either continues working (on revise) or exits (on accept/escalate).

**Types / APIs:**

Script path: `container/scripts/request-review.sh`. Invoked with no arguments; reads `CURRENT_TASK_ID`, `AGENT_NAME`, `AGENT_ID`, `PROJECT_ID`, `SERVER_URL`, `WORK_BRANCH` from the environment (matches [container/hooks/forward_build_test.sh](../container/hooks/forward_build_test.sh)).

Stdout JSON shape (exactly one of):

```json
{"decision": "accept"}
{"decision": "revise", "cycle": <N>, "findings": [<ConsolidatedFinding>, ...]}
{"decision": "escalate", "reason": "<arbitrator note>"}
```

Exit codes: 0 on `accept` and `revise` (the engineer continues either way), 1 on `escalate`, 2 on infrastructure failure (server unreachable, missing claude binary, malformed response).

**Work:**

Script flow, in order:

1. Validate environment: `CURRENT_TASK_ID` must be numeric, `AGENT_NAME` non-empty, claude binary on PATH, jq available. Exit 2 on any check failure.
2. Commit + push the working tree to the bare repo (same pattern as [container/hooks/forward_build_test.sh](../container/hooks/forward_build_test.sh) lines 80–88).
3. POST `/tasks/${CURRENT_TASK_ID}/request-review` with empty body on the first attempt, or `{"expectedCycle": N}` on a retry. Read `{cycle, reviewers}` from the response. Exit 2 on a non-200.
4. For each role in `reviewers`, call `_inline_spawn_reviewer` from [container/lib/inline-spawn-helpers.sh](../container/lib/inline-spawn-helpers.sh) in parallel. Wait for all subprocess to complete. Apply the existing 2-retry budget on any role whose `/reviews` row is still missing after its spawn returns.
5. Poll `GET /tasks/${CURRENT_TASK_ID}/reviews/${cycle}` until every declared reviewer is present, or the 2-retry budget is exhausted. If exhausted, exit 2 (the daisy-chain recovery will pick up the task on next container launch).
6. POST `/tasks/${CURRENT_TASK_ID}/finalize-review-cycle` (empty body). Read the response.
7. If `decision === "accept"`: print `{"decision": "accept"}` to stdout, exit 0.
8. If `decision === "revise"`: print the response verbatim (it already contains `cycle` and `findings`), exit 0.
9. If `decision === "arbitrate"`: call `_inline_spawn_arbitrator` with the returned arbitrator basename. After it returns (and posts its `arbitration_runs` row), POST `/tasks/${CURRENT_TASK_ID}/finalize-arbitration` (empty body). Read the arbitrator verdict:
   - On `decision === "accept"`: print `{"decision": "accept"}` to stdout (the override note is logged to stderr for the operator but the engineer's response is the same as a normal accept), exit 0.
   - On `decision === "escalate"`: print `{"decision": "escalate", "reason": "<note>"}`, exit 1.

The script must NOT post any FSM transitions itself. All transitions are server-owned via the three endpoints from Phases 1–3.

**Verification:**
- `bash -n container/scripts/request-review.sh` parses clean.
- End-to-end integration is exercised by the server-side test in Phase 7 (which simulates the script's HTTP calls without spawning real claude subprocesses).
- Manual smoke check: launch a container against a test task, observe the engineer call the script, observe the three endpoints fire in sequence, observe reviewer subprocesses log to `.scratch/reviews/<task-id>/cycle-1/`.

<!-- PHASE-BOUNDARY -->

## Phase 6 — Engineer agent definition updates

**Outcome:** The engineer's compiled prompt instructs it to call `container/scripts/request-review.sh` after each implementation chunk, parse the stdout JSON, and act on it: continue in the same session on `revise`, post the terminal `completed` transition and exit on `accept`, post the terminal `failed` transition with reason `arbitrator_escalated` and exit on `escalate`. The previous instruction to POST `engineering → built` and exit on a clean build is removed.

**Types / APIs:** prompt-level change only — no code types.

**Work:**

- Identify the engineer dynamic-agent definitions ([dynamic-agents/container-implementer-ue.md](../dynamic-agents/container-implementer-ue.md) and any project-specific implementer variants — grep `dynamic-agents/*.md` for ones whose front-matter declares an `engineer` role or whose filename matches `*implementer*`).
- Update the operating-instructions section to describe the new workflow:
  - "After completing each implementation chunk, run `bash /workspace/container/scripts/request-review.sh`. The script prints one JSON line on stdout."
  - Document the three possible response shapes and the loop behavior.
  - Document that on `accept` the engineer posts the terminal `completed` transition and exits; on `escalate` the engineer posts the terminal `failed` transition with `failureReason === "arbitrator_escalated"` and exits.
- Remove any prior instruction to POST `engineering → built` directly or to exit on a clean build.
- Recompile via `compile-agent <engineer-type>` and inspect the resulting `.compiled-agents/<engineer-type>.md` to confirm the new workflow is present and the old instruction is gone.

**Verification:**
- `npx tsx server/src/bin/compile-agent.ts container-implementer-ue` (and any other engineer variants) exits 0.
- Manual prompt review: the compiled markdown contains the new workflow paragraph; grep for the old `engineering → built` instruction confirms it is absent.

<!-- PHASE-BOUNDARY -->

## Phase 7 — Daisy-chain happy-path simplification

**Outcome:** On the happy path the engineer's `claude -p` invocation spans the entire task lifetime: `claimed → engineering → built → reviewing → (revising → engineering → built → reviewing)* → completed` (or `→ arbitrating → completed|failed`). The daisy-chain in [container/lib/pump-loop.sh](../container/lib/pump-loop.sh) spawns the engineer once and waits for terminal status. The reviewer-fanout and arbitrator role-dispatch paths remain in the daisy-chain as recovery only — entered only when a fresh container resumes a task already in `built`, `reviewing`, or `arbitrating` status.

**Types / APIs:** control-flow only — no type changes.

**Work:**

- In [container/lib/pump-loop.sh](../container/lib/pump-loop.sh), the `_role_for_status` mapping does not change: `built`/`reviewing` still maps to `reviewer-fanout`, `arbitrating` still maps to `arbitrator`. These mappings now only fire on recovery.
- Remove the `_post_engineer_entry_transition` call site at [container/lib/pump-loop.sh](../container/lib/pump-loop.sh) line 243. The request-review endpoint (Phase 1) now owns the `claimed → engineering` and `revising → engineering` transitions. Keep the function definition itself in case a future recovery path needs it, but unreference it from the daisy-chain loop.
- Update the `_run_daisy_chain` docstring at [container/lib/pump-loop.sh](../container/lib/pump-loop.sh) line 187 to state that on the happy path the engineer session traverses every non-terminal status itself, and the reviewer-fanout / arbitrator dispatch branches are exercised only when a fresh container resumes a task that the prior engineer's session left mid-state.
- Retain the abnormal-shutdown and role_session_no_op detection logic unchanged — they continue to gate failure transitions.

**Verification:**
- `bash -n container/lib/pump-loop.sh` parses clean.
- Manual trace of a happy-path run: claim → engineer spawned once → engineer calls request-review.sh internally → engineer reaches `completed` → daisy-chain exits the loop on terminal status without ever calling `_role_for_status` for `built`/`reviewing`/`arbitrating`.
- Manual trace of a recovery run: kill a container while a task sits in `reviewing` → relaunch the same agent slot → [container/lib/pump-loop.sh](../container/lib/pump-loop.sh) `_resume_in_flight_tasks` finds the task → daisy-chain dispatches `reviewer-fanout` role and completes the cycle.

<!-- PHASE-BOUNDARY -->

## Phase 8 — Integration test and documentation

**Outcome:** A server-side integration test walks the full state machine from `engineering` to `completed` via multiple revise cycles and a cycle-5 arbitration path, asserting at each transition that the FSM state and the response payload match the contract. CLAUDE.md and the operational runbook document the new transport.

**Types / APIs:** test code only — no production API changes.

**Work:**

- Write [server/src/routes/request-review.integration.test.ts](../server/src/routes/request-review.integration.test.ts):
  - Seed a task in `engineering` with three declared reviewers.
  - Call `POST /tasks/:id/request-review` → assert `cycle === 1`, status row is `reviewing`.
  - POST three `/tasks/:id/reviews` rows with `request_changes` verdicts and one BLOCKING finding each (forces classifyReview === "revise").
  - Call `POST /tasks/:id/finalize-review-cycle` → assert `decision === "revise"`, status row is `engineering`, response findings contain all three rows.
  - Loop the above four steps for cycles 2, 3, 4 (each time with revise verdicts).
  - On cycle 5: same setup, but assert `decision === "arbitrate"`, status row is `arbitrating`, response arbitrator basename matches `agentRoles.arbitrator`.
  - POST one `arbitration_runs` row with `verdict === "override_approve"`.
  - Call `POST /tasks/:id/finalize-arbitration` → assert `decision === "accept"`, status row is `completed`.
- Repeat the cycle-5 path with `verdict === "escalate"` and assert `decision === "escalate"` and status `failed` with `failureReason === "arbitrator_escalated"`.
- Update [CLAUDE.md](../CLAUDE.md) under "Coordination Server" to list the three new endpoints and under "Task-Queue Execution" to describe the in-session review loop.
- Add an entry to [Notes/operational-runbook.md](../Notes/operational-runbook.md) for diagnosing a stuck request-review (engineer blocked on the script for too long): how to read `tasks.status`, how to inspect `/tasks/:id/reviews/:cycle` for missing reviewer rows, how to manually force `reviewing → revising` to unblock.

**Verification:**
- `cd server && npm run typecheck` passes.
- `cd server && npm test` passes including the new integration test.
- `cd server && npm run db:migrate` (no migration in this plan, but a sanity check that no schema change is implied).
- Manual: read CLAUDE.md and the runbook entry end-to-end; verify all internal links resolve.
