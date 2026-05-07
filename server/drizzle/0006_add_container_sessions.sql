CREATE TABLE "claude_code_container_sessions" (
  "id"                    uuid PRIMARY KEY,
  "project_id"            text NOT NULL REFERENCES "projects"("id"),
  "agent_id"              uuid NOT NULL REFERENCES "agents"("id"),
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
