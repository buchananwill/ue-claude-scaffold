# Changelog

All notable changes to this scaffold are recorded here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); dates use ISO-8601.

## [Unreleased] — 2026-05-11

### Changed (BREAKING)

- **Task execution model migrated to a server-managed FSM with parallel role sessions.** The
  in-container orchestrator agent is gone. Task lifecycle (`pending → claimed → engineering →
  built → reviewing → revising | arbitrating → complete | failed`) is now durable state on the
  `tasks` table; `container/lib/pump-loop.sh` dispatches each role as its own top-level
  `claude -p` session against the FSM transition endpoints. See
  `plans/durable-task-fsm-and-parallel-role-sessions/` for the full design.
- **Per-project role wiring lives in `scaffold.config.json` under `agentRoles`.** Required keys:
  `engineer` (string), `arbitrator` (string), `reviewers` (non-empty object whose keys match
  `^[a-z][a-z0-9_-]{0,31}$` and whose values are bare `dynamic-agents/` or `agents/` filenames
  without the `.md` extension). Validated by Zod at config load and on every
  `agentRolesOverride` write. The canonical shape ships in `scaffold.config.example.json`.

### Removed

- `dynamic-agents/container-orchestrator-ue.md` — retired by the FSM cutover. Its quality
  protocol (build gate, parallel reviewer fan-out, consolidation, 5-cycle budget, terminal style
  sweep) is preserved by the server FSM and the reviewer / engineer roles named in `agentRoles`.
- `.compiled-agents/container-orchestrator-ue.md` — generated artifact; deleted alongside its
  source for an atomic cutover. (No twin existed on the working tree at the time of removal; the
  next `compile-agent` run would have dropped it anyway.)

### Migration

The schema fork that backs this change is delivered by the upcoming
`server/drizzle/<NNNN>_fork_tasks_for_fsm.sql` migration (number assigned when the operator
authors the file from a Drizzle stub during the production cutover; see Phase 9 of the plan for
the exact SQL sequence). The migration archives `tasks`, `task_files`, `task_dependencies` as
`*_pre_fsm_archive`, creates the new FSM-shaped tables plus `review_runs`, `review_findings`,
`arbitration_runs`, and adds `projects.agent_roles jsonb NOT NULL`. The operator seeds
`projects.agent_roles` from `scaffold.config.json` before restarting the server.
