-- Phase 9 cutover: archive the legacy tasks ecosystem as a pre-FSM epoch,
-- create new same-named tables for the FSM epoch.
--
-- The legacy ecosystem (tasks, task_files, task_dependencies,
-- claude_code_container_sessions) is renamed in place to *_pre_fsm_archive
-- variants. Postgres tracks FK target tables by OID, not by name, so the
-- intra-ecosystem FKs survive intact — historical session→task joins still
-- work via the archive tables for forensic queries. Identifier names
-- (PK / CHECK / FK constraints, indexes) are renamed alongside the table so
-- the new tables can claim the original names cleanly.
--
-- The new tables are born empty. Server code that addresses tasks /
-- task_files / task_dependencies / claude_code_container_sessions by name
-- continues to work unchanged — it just operates on the new ecosystem.
--
-- claude_code_container_sessions specifically is archived (not just FK-
-- downgraded) because the FSM design produces many sessions per task
-- (engineer + parallel reviewers + arbitrator) versus the legacy single-
-- orchestrator-per-task model. Cross-era per-task aggregates would be
-- silently misleading if rows from both models coexisted in one table.
--
-- See plans/durable-task-fsm-and-parallel-role-sessions/phase-9-hard-cutover-legacy-removal-and-documentation.md.

-- ── Archive the legacy ecosystem ──────────────────────────────────────────

ALTER TABLE "tasks" RENAME TO "tasks_pre_fsm_archive";
--> statement-breakpoint
ALTER TABLE "tasks_pre_fsm_archive" RENAME CONSTRAINT "tasks_pkey"                          TO "tasks_pre_fsm_archive_pkey";
--> statement-breakpoint
ALTER TABLE "tasks_pre_fsm_archive" RENAME CONSTRAINT "tasks_status_check"                  TO "tasks_pre_fsm_archive_status_check";
--> statement-breakpoint
ALTER TABLE "tasks_pre_fsm_archive" RENAME CONSTRAINT "tasks_agent_type_override_check"     TO "tasks_pre_fsm_archive_agent_type_override_check";
--> statement-breakpoint
ALTER INDEX "idx_tasks_status"   RENAME TO "idx_tasks_status_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_tasks_priority" RENAME TO "idx_tasks_priority_pre_fsm_archive";
--> statement-breakpoint

ALTER TABLE "task_files" RENAME TO "task_files_pre_fsm_archive";
--> statement-breakpoint
ALTER TABLE "task_files_pre_fsm_archive" RENAME CONSTRAINT "task_files_task_id_file_path_pk" TO "task_files_pre_fsm_archive_pk";
--> statement-breakpoint
ALTER INDEX "idx_task_files_path" RENAME TO "idx_task_files_path_pre_fsm_archive";
--> statement-breakpoint

ALTER TABLE "task_dependencies" RENAME TO "task_dependencies_pre_fsm_archive";
--> statement-breakpoint
ALTER TABLE "task_dependencies_pre_fsm_archive" RENAME CONSTRAINT "task_dependencies_task_id_depends_on_pk" TO "task_dependencies_pre_fsm_archive_pk";
--> statement-breakpoint
ALTER TABLE "task_dependencies_pre_fsm_archive" RENAME CONSTRAINT "task_deps_no_self"                       TO "task_deps_no_self_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_task_deps_task" RENAME TO "idx_task_deps_task_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_task_deps_dep"  RENAME TO "idx_task_deps_dep_pre_fsm_archive";
--> statement-breakpoint

ALTER TABLE "claude_code_container_sessions" RENAME TO "claude_code_container_sessions_pre_fsm_archive";
--> statement-breakpoint
ALTER TABLE "claude_code_container_sessions_pre_fsm_archive" RENAME CONSTRAINT "claude_code_container_sessions_pkey"           TO "claude_code_container_sessions_pre_fsm_archive_pkey";
--> statement-breakpoint
ALTER TABLE "claude_code_container_sessions_pre_fsm_archive" RENAME CONSTRAINT "ccs_status_check"                              TO "ccs_status_check_pre_fsm_archive";
--> statement-breakpoint
ALTER TABLE "claude_code_container_sessions_pre_fsm_archive" RENAME CONSTRAINT "claude_code_container_sessions_agent_id_fkey"   TO "claude_code_container_sessions_pre_fsm_archive_agent_id_fkey";
--> statement-breakpoint
ALTER TABLE "claude_code_container_sessions_pre_fsm_archive" RENAME CONSTRAINT "claude_code_container_sessions_project_id_fkey" TO "claude_code_container_sessions_pre_fsm_archive_project_id_fkey";
--> statement-breakpoint
ALTER TABLE "claude_code_container_sessions_pre_fsm_archive" RENAME CONSTRAINT "claude_code_container_sessions_task_id_fkey"    TO "claude_code_container_sessions_pre_fsm_archive_task_id_fkey";
--> statement-breakpoint
ALTER INDEX "idx_ccs_project"         RENAME TO "idx_ccs_project_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_ccs_agent"           RENAME TO "idx_ccs_agent_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_ccs_task"            RENAME TO "idx_ccs_task_pre_fsm_archive";
--> statement-breakpoint
ALTER INDEX "idx_ccs_project_started" RENAME TO "idx_ccs_project_started_pre_fsm_archive";
--> statement-breakpoint

-- ── Build the new FSM ecosystem ───────────────────────────────────────────

CREATE TABLE "tasks" (
  "id"                             serial PRIMARY KEY,
  "project_id"                     text NOT NULL REFERENCES "projects"("id"),
  "title"                          text NOT NULL,
  "description"                    text DEFAULT '',
  "source_path"                    text,
  "acceptance_criteria"            text,
  "status"                         text NOT NULL DEFAULT 'pending',
  "priority"                       integer NOT NULL DEFAULT 0,
  "base_priority"                  integer NOT NULL DEFAULT 0,
  "claimed_by_agent_id"            uuid REFERENCES "agents"("id") ON DELETE RESTRICT,
  "claimed_at"                     timestamp,
  "completed_at"                   timestamp,
  "result"                         jsonb,
  "progress_log"                   text,
  "agent_type_override"            text,
  "review_cycle_count"             integer NOT NULL DEFAULT 0,
  "review_cycle_budget"            integer NOT NULL DEFAULT 5,
  "reviewer_verdicts"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "latest_review_path"             text,
  "build_status"                   text NOT NULL DEFAULT 'pending',
  "commit_sha"                     text,
  "arbitration_pending_trigger"    text,
  "arbitration_addendum_path"      text,
  "failure_reason"                 text,
  "failure_detail"                 text,
  "agent_roles_override"           jsonb,
  "created_at"                     timestamp DEFAULT now(),
  CONSTRAINT "tasks_status_check" CHECK ("status" IN (
    'pending','claimed','engineering','built','reviewing',
    'revising','arbitrating','complete','failed','integrated','cycle'
  )),
  CONSTRAINT "tasks_agent_type_override_check" CHECK (
    "agent_type_override" IS NULL OR "agent_type_override" ~ '^[a-zA-Z0-9_-]{1,64}$'
  ),
  CONSTRAINT "tasks_build_status_check" CHECK ("build_status" IN (
    'pending','clean','dirty','failed'
  )),
  CONSTRAINT "tasks_failure_reason_check" CHECK (
    "failure_reason" IS NULL OR "failure_reason" IN (
      'review_cycle_budget_exhausted',
      'reviewer_contradiction',
      'engineer_build_failure',
      'reviewer_infrastructure_failure',
      'role_session_no_op',
      'arbitrator_escalated'
    )
  )
);
--> statement-breakpoint
CREATE INDEX "idx_tasks_status"   ON "tasks" ("status");
--> statement-breakpoint
CREATE INDEX "idx_tasks_priority" ON "tasks" ("priority" DESC, "id" ASC);
--> statement-breakpoint

CREATE TABLE "task_files" (
  "task_id"   integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "file_path" text NOT NULL,
  PRIMARY KEY ("task_id", "file_path")
);
--> statement-breakpoint
CREATE INDEX "idx_task_files_path" ON "task_files" ("file_path");
--> statement-breakpoint

CREATE TABLE "task_dependencies" (
  "task_id"    integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "depends_on" integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  PRIMARY KEY ("task_id", "depends_on"),
  CONSTRAINT "task_deps_no_self" CHECK ("task_id" != "depends_on")
);
--> statement-breakpoint
CREATE INDEX "idx_task_deps_task" ON "task_dependencies" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_task_deps_dep"  ON "task_dependencies" ("depends_on");
--> statement-breakpoint

CREATE TABLE "claude_code_container_sessions" (
  "id"                    uuid PRIMARY KEY,
  "project_id"            text NOT NULL REFERENCES "projects"("id"),
  "agent_id"              uuid NOT NULL REFERENCES "agents"("id") ON DELETE RESTRICT,
  "task_id"               integer REFERENCES "tasks"("id") ON DELETE SET NULL,
  "status"                text NOT NULL DEFAULT 'running',
  "started_at"            timestamp NOT NULL DEFAULT now(),
  "ended_at"              timestamp,
  "exit_code"             integer,
  "input_tokens"          integer,
  "output_tokens"         integer,
  "cache_read_tokens"     integer,
  "cache_creation_tokens" integer,
  "raw_output"            jsonb,
  CONSTRAINT "ccs_status_check" CHECK ("status" IN ('running','complete','aborted','stopped'))
);
--> statement-breakpoint
CREATE INDEX "idx_ccs_project"         ON "claude_code_container_sessions" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_agent"           ON "claude_code_container_sessions" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_task"            ON "claude_code_container_sessions" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_project_started" ON "claude_code_container_sessions" ("project_id", "started_at" DESC);
--> statement-breakpoint
COMMENT ON COLUMN "claude_code_container_sessions"."raw_output" IS 'Raw final stream-json result event from claude -p. May contain user prompts, file paths, and other agent-supplied content. Read endpoints MUST filter by agent_id to prevent cross-agent leakage. No size bound enforced at the DB layer; monitor row size in operations.';
--> statement-breakpoint

CREATE TABLE "review_runs" (
  "id"            serial PRIMARY KEY,
  "task_id"       integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "cycle"         integer NOT NULL,
  "reviewer_role" text NOT NULL,
  "verdict"       text NOT NULL,
  "raw_markdown"  text NOT NULL,
  "posted_at"     timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "review_runs_task_cycle_role_unique" UNIQUE ("task_id", "cycle", "reviewer_role"),
  CONSTRAINT "reviewer_runs_verdict_check" CHECK ("verdict" IN (
    'approve','request_changes','out_of_scope'
  ))
);
--> statement-breakpoint
CREATE INDEX "idx_review_runs_task_cycle" ON "review_runs" ("task_id", "cycle");
--> statement-breakpoint

CREATE TABLE "arbitration_runs" (
  "id"                       serial PRIMARY KEY,
  "task_id"                  integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "trigger"                  text NOT NULL,
  "ruling"                   text NOT NULL,
  "ruling_markdown"          text NOT NULL,
  "contradiction_resolution" jsonb,
  "posted_at"                timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "arbitration_runs_task_trigger_unique" UNIQUE ("task_id", "trigger"),
  CONSTRAINT "arbitration_runs_trigger_check" CHECK ("trigger" IN (
    'review_cycle_budget_exhausted','reviewer_contradiction'
  )),
  CONSTRAINT "arbitration_runs_ruling_check" CHECK ("ruling" IN (
    'approve','rule','escalate'
  )),
  CONSTRAINT "arbitration_runs_rule_resolution_check" CHECK (
    ("ruling" = 'rule' AND "contradiction_resolution" IS NOT NULL)
    OR
    ("ruling" <> 'rule' AND "contradiction_resolution" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "idx_arbitration_runs_task" ON "arbitration_runs" ("task_id");
--> statement-breakpoint

CREATE TABLE "review_findings" (
  "id"          serial PRIMARY KEY,
  "run_id"      integer NOT NULL REFERENCES "review_runs"("id") ON DELETE CASCADE,
  "severity"    text NOT NULL,
  "ordinal"     integer NOT NULL,
  "file_path"   text,
  "line"        integer,
  "title"       text NOT NULL,
  "description" text NOT NULL,
  "evidence"    text,
  "fix"         text,
  CONSTRAINT "review_findings_severity_check" CHECK ("severity" IN ('BLOCKING','NOTE'))
);
--> statement-breakpoint
CREATE INDEX "idx_review_findings_run"           ON "review_findings" ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_review_findings_task_severity" ON "review_findings" ("severity");

-- ── Note on agent-role wiring ─────────────────────────────────────────────
--
-- The FSM design plan originally proposed adding a `projects.agent_roles`
-- jsonb column to persist the engineer / arbitrator / reviewers map. That
-- column has been intentionally omitted: agent definitions are operator-local
-- markdown on disk where the server runs (dynamic-agents/ + compiled-agents/),
-- so the role-→-agent mapping is operator-local config rather than portable
-- project state. The authoritative source is scaffold.config.json, colocated
-- in the repo with the markdown that names the agent definitions.
