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
CREATE INDEX "idx_ccs_project" ON "claude_code_container_sessions" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_agent" ON "claude_code_container_sessions" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_task" ON "claude_code_container_sessions" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_project_started" ON "claude_code_container_sessions" ("project_id", "started_at" DESC);
--> statement-breakpoint
COMMENT ON COLUMN "claude_code_container_sessions"."raw_output" IS 'Raw final stream-json result event from claude -p. May contain user prompts, file paths, and other agent-supplied content. Read endpoints MUST filter by agent_id to prevent cross-agent leakage. No size bound enforced at the DB layer; monitor row size in operations.';
