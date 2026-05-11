# Debrief 0199 — Phase 4: container daisy-chain entrypoint

## Task Summary

Implement Phase 4 of the durable-task FSM plan: replace the per-task body of
`_pump_iteration` with a state-driven daisy-chain that reads `task.status`,
picks a role from the FSM, runs that role as a top-level `claude -p` session,
and repeats until terminal. Drop the legacy `_trip_noncomplete_circuit_breaker`
and the auto-`/complete`/`/fail` posts in `run-claude.sh` (transitions are now
exclusively authored by living role sessions). Add a `claimedByAgentId` UUID
filter to `GET /tasks` plus a startup probe that resumes in-flight tasks for
the current agent UUID.

## Changes Made

### Server

- `server/src/queries/tasks-core.ts` — added `claimedByAgentId?: string` to
  `ListOpts` and `CountOpts`; extended `buildFilterConditions` with a single
  `eq(tasks.claimedByAgentId, ?)` clause when present.
- `server/src/routes/tasks.ts` — added a UUID regex (`UUID_RE`),
  `claimedByAgentId` to `TaskListQueryInput` / `ParsedTaskListQuery`, regex
  validation in `parseTaskListQuery` (400 on malformed), and wired it through
  the `GET /tasks` Querystring type and `filterOpts`.
- `server/src/queries/projects.ts` — surfaced `agentRoles` on the `ProjectRow`
  type via a new `AgentRoleMap` interface so the container daisy-chain can
  read project-default role wiring from `GET /projects/:id`. The column was
  already in the schema (Phase 1) and returned by `db.select()`; only the
  public type was hiding it via `as ProjectRow` casts.
- `server/src/routes/tasks.test.ts` — three new tests:
  - valid-UUID filter returns the matching task only
  - malformed UUID returns 400 with a `claimedByAgentId` message
  - unknown but well-formed UUID returns an empty list

### Container

- `container/lib/pump-loop.sh` — full rewrite of the per-task body:
  - new `_role_for_status` mapping (claimed/revising → engineer,
    engineering → engineer, built/reviewing → reviewer-fanout,
    arbitrating → arbitrator, terminal → empty)
  - new `_resolve_roles_for_task` that fetches `GET /projects/:id` and
    `GET /tasks/:id` and shallow-merges `project.agentRoles` with
    `task.agentRolesOverride` (top-level keys replace wholesale, per the
    plan's documented contract)
  - new `_run_role_session` that ensures `.scratch/reviews/<task-id>/cycle-<N>/`
    exists, sets `DAISY_CHAIN_ROLE` / `DAISY_CHAIN_ROLES_FILE` /
    `DAISY_CHAIN_CYCLE` / `DAISY_CHAIN_LOG` env vars, and invokes `_run_claude`
  - new `_run_daisy_chain` driver loop that re-reads `task.status`, picks the
    role, runs the session, re-reads, and posts `role_session_no_op → failed`
    via `/transition` if the session exited cleanly without transitioning
  - new `_resume_in_flight_tasks` for the startup probe (filters by
    `?status=engineering,built,reviewing,revising,arbitrating&claimedByAgentId=$AGENT_ID`,
    hydrates `CURRENT_TASK_*` from each row, runs the daisy-chain)
  - reviewer-fanout / arbitrator are explicitly stubbed: the loop halts
    cleanly when these roles are picked, leaving the task in its current
    status for Phase 6/7 to pick up
  - dropped `_trip_noncomplete_circuit_breaker` and `_bump_consecutive_noncomplete`
    (zero `git grep _trip_noncomplete_circuit_breaker container/` matches now)
  - preserved CONSECUTIVE_ABNORMAL ≥ 2 → circuit_break, abnormal-exit
    detection, pause/resume polling, stop-signal handling, agent-type override
    fetch, per-task branch reset
- `container/lib/run-claude.sh` —
  - deleted the auto-`/complete` and auto-`/fail` block (the entire
    `if [ "$mode" = "task" ] && [ -n "$CURRENT_TASK_ID" ]` block based on
    Claude's exit code). The `/release` post on the abnormal-exit branch is
    untouched.
  - added daisy-chain agent selection: when `DAISY_CHAIN_ROLE` and
    `DAISY_CHAIN_ROLES_FILE` are set, look up the agent-definition basename
    from the resolved roles JSON. Falls back to the existing
    `CURRENT_TASK_AGENT_TYPE` / `AGENT_TYPE` precedence if the role is
    unmapped or the JSON lookup fails. Allowlist validation preserved.
- `container/entrypoint.sh` — call `_resume_in_flight_tasks` once before the
  pump-loop's claim cycle starts (only in multi-task mode).
- `container/lib/env.sh` — removed `CONSECUTIVE_NONCOMPLETE`,
  `CONSECUTIVE_NONCOMPLETE_LIMIT`, `RECENT_NONCOMPLETE_TASK_IDS` and their
  comment block (no callers remain).

### Repo

- `.gitignore` — added `.scratch/reviews/` and `.scratch/arbitrations/` so
  per-cycle review session logs and arbitrator workspaces are never staged.

## Design Decisions

- **Stub for reviewer-fanout / arbitrator.** The plan explicitly leaves
  Phase 6/7 work out of scope but requires the daisy-chain mapping to include
  these role names. I implemented this by halting the daisy-chain loop with
  a clear log message ("role X is stubbed pending Phase 6/7") rather than
  invoking `_run_role_session`. This preserves task state on the server for
  the next phase to pick up; it will not cause `role_session_no_op` because
  no session ran. A built task that is daisy-chained today will simply log
  the stub and exit the inner loop; the outer pump claims the next pending
  task.

- **Effective roles passed via env + JSON tmpfile.** `_run_role_session`
  writes the merged roles to a tmpfile and exports `DAISY_CHAIN_ROLES_FILE`
  so `run-claude.sh` can `jq` the role-to-agent mapping at the moment of
  invocation. I did not add a CLI flag for the role; this keeps the existing
  `_run_claude` signature `(prompt, mode)` stable and avoids touching the
  chat / direct paths.

- **Surfacing `agentRoles` on `ProjectRow`.** The schema already had the
  column (Phase 1) and `db.select().from(projects)` returned it; only the
  public TypeScript type masked it via `as ProjectRow` casts. I widened the
  type rather than introducing schema work — the data is already on the wire
  in `GET /projects/:id`'s JSON response, and the daisy-chain shell code
  reads `.agentRoles // {}` from that JSON via `jq`.

- **`/transition` payload for `role_session_no_op`.** Verified against
  `server/src/routes/tasks-lifecycle.ts`: `FAILURE_REASONS` includes
  `'role_session_no_op'` and the `to: 'failed'` branch accepts
  `payload.failureReason` + `payload.failureDetail`. Used the literal payload
  shape from the plan.

- **agent-type-override fetch failure.** The legacy code posted `/fail`
  directly and bumped the noncomplete counter. Under the FSM, the daisy-chain
  is the authority on terminal transitions, but a fetch failure happens
  *before* any role session runs. I post `/transition` with `to: 'failed',
  failureReason: 'role_session_no_op', failureDetail: 'agent-type-fetch-failed:<type>'`
  in `_pump_iteration` and skip the daisy-chain. This routes the task to a
  terminal state without re-claiming in a tight loop, and the failure surfaces
  on the Phase 8 dashboard via the same aggregator as in-session no-ops.

- **Did not add target-project bootstrap doc entries.** The plan mentions
  adding `.scratch/reviews/` to "every target project" via bootstrap docs.
  No central bootstrap doc exists in the scaffold (operational-runbook is
  about DB rollback, not project bootstrapping), so per the task brief I
  flagged this as a follow-up rather than guessing.

## Build & Test Results

- `cd server && npm run build` — clean (`tsc` exits 0).
- `cd server && npx tsx --test src/queries/tasks-core.test.ts` — 17 pass /
  0 fail.
- `cd server && npx tsx --test src/routes/tasks.test.ts ...` (all task suites I
  touched, plus tasks-core, tasks-claim, tasks-lifecycle): 149 pass, 2 fail.
  The 2 fails (`DELETE /tasks bulk-delete by status` / "deletes completed
  tasks…" and "scopes deletion to the requesting project") are **pre-existing**
  — confirmed by stashing my changes and re-running: same 2 failures on
  baseline. They appear related to the legacy `/complete` endpoint rather
  than my filter or shell work.
- `cd server && npm test` (full suite) — 676 pass / 54 fail. **Confirmed
  pre-existing**: stashed all my changes and re-ran `tasks-deps.test.ts`
  alone — same 46 failures, all due to the test-helper invoking
  `git commit-tree` without an author identity (no global git config in this
  container). The remaining 8 failures across `agents.test.ts` /
  `projects.test.ts` are also pre-existing (verified projects.test.ts: 11
  pass / 2 fail on baseline, identical to my run). My changes neither caused
  nor fixed any of these.
- `bash -n container/entrypoint.sh container/lib/{pump-loop,run-claude,env}.sh`
  — all clean.
- `git grep _trip_noncomplete_circuit_breaker container/` — zero matches
  (acceptance criterion satisfied).

## Open Questions / Risks

- **Engineer prompt is still the generic task prompt.** Phase 5 will replace
  `_run_role_session`'s prompt construction with role-specific prompts; for
  now the engineer role uses the existing `_build_task_prompt`. This is
  consistent with the plan's intent that Phases 5/6/7 layer role-specific
  invocation logic on top of Phase 4's daisy-chain shape.

- **`agentRoles` defaults to `{}`.** `projects.queries.ts` seeds new projects
  with `agentRoles: {}`. Until config-load (Phase 9) populates real role
  wiring, the daisy-chain will fall back to `CURRENT_TASK_AGENT_TYPE` /
  `AGENT_TYPE`. This is the existing behaviour for non-FSM containers and
  preserves correctness — but if an operator runs a task through the daisy-
  chain *without* the per-project config seed, every role will resolve to
  the container default `AGENT_TYPE`. That is a Phase 9 follow-up, not a
  Phase 4 bug.

- **Project-route ProjectRow widening.** I added `agentRoles: AgentRoleMap`
  to the public `ProjectRow` type. `projects.queries.ts:create` already
  inserts `agentRoles: {}`, and `db.select().from(projects)` already returns
  the column (it was hidden by the `as ProjectRow` cast). No new endpoint
  exposes write access — the field is read-only via `GET /projects` and
  `GET /projects/:id`, exactly as the plan needs.

- **Per-task agent override during daisy-chain.** Today
  `CURRENT_TASK_AGENT_TYPE` (the per-task override fetched at claim time)
  applies to all roles in the daisy-chain unless a role-specific entry in
  `agentRoles` overrides it. The plan does not explicitly state precedence
  between `agentTypeOverride` (the legacy single-string override) and the
  new `agentRoles` map. I went with: daisy-chain role wins if the role is
  in the resolved roles map; otherwise fall back to the existing
  `CURRENT_TASK_AGENT_TYPE` → `AGENT_TYPE` precedence. This preserves legacy
  behaviour for tasks that don't use FSM yet.

## Suggested Follow-ups

- Phase 5: replace the generic task prompt in `_run_role_session` with an
  engineer-specific prompt that explicitly names the FSM transitions the
  engineer is expected to post (`built` on success, `failed` on
  unrecoverable build failure).
- Phase 6/7: wire reviewer-fanout and arbitrator role sessions; remove the
  Phase 4 stub-halt path.
- Phase 9: seed per-project `agentRoles` from `scaffold.config.json` so the
  daisy-chain has real role-to-agent wiring rather than the empty-default
  `{}` fallback.
- Add a target-project bootstrap doc that lists `.gitignore` requirements
  (including `.scratch/reviews/` and `.scratch/arbitrations/`). The scaffold
  does not currently have one; this is a documentation effort separate from
  Phase 4's code work.
- Investigate the pre-existing `DELETE /tasks bulk-delete by status` test
  failures — they appear to predate the durable-task FSM rework and are
  unrelated to Phase 4 scope.
