ALTER TABLE "tasks" ADD COLUMN "agent_type_override" text;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_type_override_check" CHECK ("agent_type_override" IS NULL OR "agent_type_override" ~ '^[a-zA-Z0-9_-]{1,64}$');
