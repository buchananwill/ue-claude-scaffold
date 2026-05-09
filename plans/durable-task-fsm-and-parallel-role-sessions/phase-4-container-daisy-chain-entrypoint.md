---

# Phase 4 — Container daisy-chain entrypoint

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `container/lib/pump-loop.sh`
- `container/lib/run-claude.sh`
- `container/entrypoint.sh`
- `server/src/routes/tasks.ts` (extend `GET /tasks` query parser to accept a `claimedByAgentId` UUID filter)
- `server/src/queries/tasks-core.ts` (extend the list query to apply the new filter)
- `.gitignore` in target project repos (add `.scratch/reviews/` and `.scratch/arbitrations/`)

**Work:**
1. Replace the per-task body of `pump-loop.sh` with a state-driven daisy-chain. After `POST /tasks/claim-next` returns a claimed task, enter a loop:
   ```
   while task.status not in (complete, failed, integrated):
     role = role_for_status(task)
     run_role_session "$role" "$task_id" "$cycle"
     task = GET /tasks/:id      # re-read to pick up any transition the session posted
   ```
   `role_for_status` mapping:
   - `claimed` or `revising` → `engineer`
   - `engineering` → `engineer` (resume; the session itself decides whether to continue or post `built`)
   - `built` → `reviewer-fanout` (Phase 6 expands this)
   - `reviewing` → `reviewer-fanout` for any reviewer not yet present in `reviewerVerdicts` (recovery from partial progress)
   - `arbitrating` → `arbitrator` (Phase 7 expands this)
   - `complete`, `failed`, `integrated` → exit task loop
2. `run_role_session` is a function that:
   - Creates `.scratch/reviews/<task-id>/cycle-<N>/` if it doesn't exist.
   - Calls `run-claude.sh <role> <task-id> <cycle>` and captures stdout/stderr to a per-role logfile under `.scratch/`.
   - The session is responsible for posting its own transition. If the session exits cleanly but no transition was posted (we read `task.status` after and it's unchanged), post `{to: 'failed', payload: {failureReason: 'role_session_no_op', failureDetail: 'role session for <role> returned without posting transition (cycle <N>)'}}`.

2a. **Effective agent-roles resolution.** At the start of each task loop iteration, the daisy-chain resolves the per-task agent-role wiring once and caches it for the loop's lifetime:
   ```
   project       = GET /projects/$PROJECT_ID
   task          = GET /tasks/:id
   roles         = shallow_merge(project.agentRoles, task.agentRolesOverride ?? {})
   ```
   `shallow_merge` replaces top-level keys (`engineer`, `arbitrator`, `reviewers`) wholesale. An override `{"reviewers": {"decomp": "custom-decomp-ue"}}` replaces the entire reviewers map, dropping safety and correctness — that is the documented contract; partial-reviewer overrides require restating the whole reviewers object. `run-claude.sh` reads from `roles` to choose the agent file and the permission posture for each invocation.
3. **Extend `GET /tasks` with a `claimedByAgentId` UUID filter.** The container's startup probe needs to recover only tasks claimed by *this* agent's UUID, not by name slot (agent UUIDs are identity; names are reusable UI labels). Add `claimedByAgentId` to the query parser in `server/src/routes/tasks.ts` and the conditions builder in `server/src/queries/tasks-core.ts`. Validate as a v4/v7 UUID; reject malformed input with 400. The filter applies a single `WHERE claimed_by_agent_id = ?` clause; no fan-out matching, no name-slot lookup.

4. **Startup probe.** On container start, query `GET /tasks?status=engineering,built,reviewing,revising,arbitrating&claimedByAgentId=<own-AGENT_ID>` and resume the daisy-chain on each returned row. A task already mid-cycle won't be re-claimed by anyone else because its status is non-`pending`; the probe is the only mechanism that picks it back up after an OAuth expiry or host reboot.

5. **Strip the auto-`/complete` and auto-`/fail` posts from `_run_claude`.** The current `container/lib/run-claude.sh` POSTs `/tasks/:id/complete` or `/tasks/:id/fail` based on Claude's exit code in its `if [ "$mode" = "task" ] && [ -n "${CURRENT_TASK_ID:-}" ]` block (lines ~291-308 of the file). Under the FSM, the role session itself posts the relevant `/transition` call; an additional auto-post from the wrapper would either double-write or clobber the FSM with a legacy `complete`/`fail` payload. Delete that block entirely. The wrapper continues to POST `/tasks/:id/release` on the abnormal-exit path (existing behavior, unchanged) — `release` is a different endpoint from `complete`/`fail` and remains valid for the "container died, hand the task back" recovery flow.

6. Add `.gitignore` entries for `.scratch/reviews/` and `.scratch/arbitrations/` to both the scaffold repo and (via project bootstrap docs) every target project. The transient cycle and arbitration artifacts must never be committed.

7. Container shutdown handler (`stop.sh` path): do **not** clear claimed tasks. The startup probe will resume them. The orchestrator is now stateless from the container's perspective.

8. **Preserve the existing pump-loop infrastructure (minus the noncomplete breaker).** The rewrite of `_pump_iteration` keeps the abnormal-exit detection (`_detect_abnormal_exit` + `ABNORMAL_SHUTDOWN`), the **`CONSECUTIVE_ABNORMAL` counter and its `≥2 abnormal exits → PUMP_STATUS=circuit_break` path** (separate from the noncomplete breaker that's being dropped — these stay), the agent-status pause/resume polling, the stop-signal sentinel (`/tmp/.stop_requested`), the agent-type-override fetch (`_ensure_agent_type`), and the per-task branch-reset between iterations. These remain non-negotiable safety nets; the daisy-chain is layered *inside* this scaffolding, not in place of it.

   The `CONSECUTIVE_ABNORMAL` breaker is still load-bearing under the new design: a container with broken auth produces abnormal exits, which now route to `/release` instead of `/fail`, but without that breaker the pump would keep claiming and releasing in a tight loop — burning server capacity without terminally failing any task. The breaker stops that loop after 2 consecutive abnormal exits.

   **Drop `_trip_noncomplete_circuit_breaker` entirely** (function and all call sites). It was load-bearing in the legacy design specifically because the pump-loop auto-posted `/complete` and `/fail` based on `claude -p` exit codes — a zombie container with broken auth could rapidly cycle through claimed tasks marking each one `failed` before the operator noticed. That auto-post path is removed in step 5 above. Under the new design, transitions are exclusively authored by living, signed-in role sessions: an auth-dead container exits non-zero and routes to `/release` (back to `pending`), never to a terminal state. The catastrophic fall-through the breaker protected against is structurally impossible. The remaining `role_session_no_op → failed` path (Phase 4 step 2) requires `claude -p` to exit cleanly *while* posting nothing, which is rare, not auth-correlated, and surfaceable via the Phase 8 Failure-reasons panel that aggregates `tasks.failure_reason` counts and flags `role_session_no_op` for operator attention. A breaker is the wrong instrument for that signal; observability is.

**Acceptance criteria:**
- `GET /tasks?claimedByAgentId=<uuid>` returns only tasks claimed by that agent UUID; `GET /tasks?claimedByAgentId=not-a-uuid` returns 400.
- A task with `status='engineering'` and `claimed_by_agent_id` equal to the running container's `AGENT_ID` is picked up by the startup probe and resumed.
- The shell loop never reads `task.status='complete'` and re-launches a session for it.
- A clean engineer-session exit no longer triggers a `POST /tasks/:id/complete` from `run-claude.sh`. The only POSTs the wrapper makes against task-lifecycle endpoints after a clean exit are the role session's own `/transition` calls (or a `/release` on the abnormal-exit branch).
- A session that exits without posting a transition causes the task to land in `failed` with `failureReason='role_session_no_op'`.
- A task with `agentRolesOverride={"reviewers": {"decomp": "custom-decomp-ue"}}` runs only the decomp reviewer for that task (safety + correctness are dropped because the override replaces the whole reviewers map). The engineer and arbitrator come from the project default.
- Killing the container mid-`reviewing` (after one of three reviewers has posted, two pending) and restarting causes the container to re-fan-out only the missing reviewers, not the one already posted.
- `_trip_noncomplete_circuit_breaker` is removed; `git grep _trip_noncomplete_circuit_breaker` returns zero matches in `container/` after the change.
- The `CONSECUTIVE_ABNORMAL` counter and its `≥2 abnormal exits → PUMP_STATUS=circuit_break` path are preserved. Verifiable: a container that produces 2 consecutive abnormal exits (e.g. auth death simulated by stubbing the auth check) trips the circuit breaker and stops the pump rather than continuing to claim/release tasks.
- Pause/resume polling, stop-signal handling, agent-type-override fetch, abnormal-exit detection, and per-task branch reset all continue to function under the new daisy-chain shape — no regression in any retained safety net. The `_trip_noncomplete_circuit_breaker` removal is intentional (covered by step 8 and the prior two criteria); it is not counted as a regression.
- The `.scratch/reviews/` directory in any project worktree is never staged by `git status`.
