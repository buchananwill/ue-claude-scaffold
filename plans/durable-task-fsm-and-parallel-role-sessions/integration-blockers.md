# Integration blockers — durable-task-FSM branch

Work items raised during pre-integration review of `bare/docker/ue-claude-scaffold/agent-4` against the [plan index](./_index.md). Delete this file after the branch lands on `main`.

## 1. Role agents cannot dispatch sub-agents

The plan's headline rationale — *"engineers can dispatch Haiku helpers for cheap searches before duplicating shared code"* — and [Phase 5](./phase-5-engineer-top-level-session-dispatch.md)'s explicit acceptance criterion (*"The engineer can spawn sub-agents during its session (verifiable from `claude_code_container_sessions.raw_output`'s tool-use entries showing Agent calls)"*) are not realised.

The five role definitions all declare an explicit `tools:` allowlist that omits the `Agent` tool:

- [dynamic-agents/container-implementer-ue.md](../../dynamic-agents/container-implementer-ue.md) — `tools: [Read, Edit, Write, Glob, Grep, Bash]`
- [dynamic-agents/container-reviewer-ue.md](../../dynamic-agents/container-reviewer-ue.md) — `tools: [Read, Glob, Grep, Bash]`
- [dynamic-agents/container-safety-reviewer-ue.md](../../dynamic-agents/container-safety-reviewer-ue.md) — `tools: [Read, Glob, Grep, Bash]`
- [dynamic-agents/container-decomposition-reviewer-ue.md](../../dynamic-agents/container-decomposition-reviewer-ue.md) — `tools: [Read, Glob, Grep, Bash]`
- [dynamic-agents/container-arbitrator-ue.md](../../dynamic-agents/container-arbitrator-ue.md) — `tools: [Read, Glob, Grep, Bash]`

Per the Claude Code subagents documentation: `claude --agent <name>` at the top level inherits the agent's *"system prompt, tool restrictions, and model"*; once `tools:` is present it is a hard allowlist; *"If `Agent` is omitted from the `tools` list entirely, the agent cannot spawn any subagents."*

**Required behaviour:** the engineer role session must be able to dispatch sub-agents. Reviewers and the arbitrator should have the same capability if we want them to delegate read-only exploration.

## 2. FSM cutover migration not authored

[Phase 9 step 3](./phase-9-hard-cutover-legacy-removal-and-documentation.md) specified a single hand-authored migration `server/drizzle/<NNNN>_fork_tasks_for_fsm.sql` that performs the rename-and-recreate cutover in one transaction. The migrations directory on the branch still ends at `0006_add_container_sessions.sql`. The new FSM shape exists only in [server/src/schema/tables.ts](../../server/src/schema/tables.ts); `npm run db:migrate` against the live Supabase will not transform the schema, because drizzle does not fabricate the rename-archive pattern from a tables.ts diff.

**Required behaviour before integration:** a `0007_fork_tasks_for_fsm.sql` migration exists, has been dry-run against a PGlite snapshot of the live Supabase, and applies cleanly. After it runs, the live database has `tasks_pre_fsm_archive` / `task_files_pre_fsm_archive` / `task_dependencies_pre_fsm_archive` retaining pre-cutover rows, fresh `tasks` / `review_runs` / `review_findings` / `arbitration_runs` tables in the FSM shape, `claude_code_container_sessions.task_id` downgraded to a soft column, and `projects.agent_roles` seeded per-project with the canonical role wiring (the migration's `DEFAULT '{}'::jsonb` satisfies NOT NULL but the application Zod validator rejects the empty map).
