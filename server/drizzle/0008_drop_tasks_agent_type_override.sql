-- Drop the `tasks.agent_type_override` column and its CHECK constraint.
--
-- This column was carried forward from the pre-FSM design (migration 0005),
-- where it was the operator's only per-task agent-selection knob. Under the
-- durable-task FSM, per-task agent selection lives on `tasks.agent_roles_override`
-- (added in 0007) — a jsonb map keyed by FSM role that shallow-merges over the
-- project default in `scaffold.config.json.projects.<id>.agentRoles`. The
-- single-column override is redundant and was never read by FSM code.
--
-- The corresponding column on `tasks_pre_fsm_archive` is left intact —
-- archived data preserves the original schema for forensic queries.

ALTER TABLE "tasks"
  DROP CONSTRAINT "tasks_agent_type_override_check";
--> statement-breakpoint
ALTER TABLE "tasks"
  DROP COLUMN "agent_type_override";
