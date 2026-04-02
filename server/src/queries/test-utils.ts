/**
 * Shared test utilities for Drizzle query module tests.
 * Creates an in-memory PGlite instance with the current schema applied via raw DDL.
 *
 * We avoid drizzle-kit migrations because PGlite has issues with certain ALTER
 * statements (e.g., integer -> boolean). Instead we create the final schema directly.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../schema/index.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface TestDb {
  db: DrizzleDb;
  close: () => Promise<void>;
}

/** DDL that matches the current schema in src/schema/tables.ts */
const SCHEMA_DDL = `
CREATE TABLE "agents" (
  "name" text PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "worktree" text NOT NULL,
  "plan_doc" text,
  "status" text DEFAULT 'idle' NOT NULL,
  "mode" text DEFAULT 'single' NOT NULL,
  "registered_at" timestamp DEFAULT now(),
  "container_host" text,
  "session_token" text,
  CONSTRAINT "agents_session_token_unique" UNIQUE("session_token")
);

CREATE TABLE "ubt_lock" (
  "project_id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "holder" text,
  "acquired_at" timestamp,
  "priority" integer DEFAULT 0
);

CREATE TABLE "ubt_queue" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "agent" text NOT NULL,
  "priority" integer DEFAULT 0,
  "requested_at" timestamp DEFAULT now()
);

CREATE TABLE "build_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "agent" text NOT NULL,
  "type" text NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "duration_ms" integer,
  "success" integer,
  "output" text,
  "stderr" text,
  CONSTRAINT "build_history_type_check" CHECK ("type" IN ('build', 'test'))
);

CREATE TABLE "messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "from_agent" text NOT NULL,
  "channel" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "claimed_by" text,
  "claimed_at" timestamp,
  "resolved_at" timestamp,
  "result" jsonb,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX "idx_messages_channel" ON "messages" ("channel");
CREATE INDEX "idx_messages_channel_id" ON "messages" ("channel", "id");
CREATE INDEX "idx_messages_claimed" ON "messages" ("claimed_by");

CREATE TABLE "tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '',
  "source_path" text,
  "acceptance_criteria" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "base_priority" integer DEFAULT 0 NOT NULL,
  "claimed_by" text,
  "claimed_at" timestamp,
  "completed_at" timestamp,
  "result" jsonb,
  "progress_log" text,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "tasks_status_check" CHECK ("status" IN ('pending','claimed','in_progress','completed','failed','integrated','cycle'))
);
CREATE INDEX "idx_tasks_status" ON "tasks" ("status");
CREATE INDEX "idx_tasks_priority" ON "tasks" ("priority" DESC, "id" ASC);

CREATE TABLE "files" (
  "project_id" text DEFAULT 'default' NOT NULL,
  "path" text NOT NULL,
  "claimant" text,
  "claimed_at" timestamp,
  CONSTRAINT "files_project_id_path_pk" PRIMARY KEY("project_id", "path")
);

CREATE TABLE "task_files" (
  "task_id" integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "file_path" text NOT NULL,
  CONSTRAINT "task_files_task_id_file_path_pk" PRIMARY KEY("task_id", "file_path")
);
CREATE INDEX "idx_task_files_path" ON "task_files" ("file_path");

CREATE TABLE "task_dependencies" (
  "task_id" integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "depends_on" integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "task_dependencies_task_id_depends_on_pk" PRIMARY KEY("task_id", "depends_on"),
  CONSTRAINT "task_deps_no_self" CHECK ("task_id" != "depends_on")
);
CREATE INDEX "idx_task_deps_task" ON "task_dependencies" ("task_id");
CREATE INDEX "idx_task_deps_dep" ON "task_dependencies" ("depends_on");

CREATE TABLE "rooms" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "rooms_type_check" CHECK ("type" IN ('group','direct'))
);

CREATE TABLE "room_members" (
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "member" text NOT NULL,
  "joined_at" timestamp DEFAULT now(),
  CONSTRAINT "room_members_room_id_member_pk" PRIMARY KEY("room_id", "member")
);

CREATE TABLE "chat_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "sender" text NOT NULL,
  "content" text NOT NULL,
  "reply_to" integer REFERENCES "chat_messages"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX "idx_chat_room_id" ON "chat_messages" ("room_id", "id");

CREATE TABLE "teams" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text DEFAULT 'default' NOT NULL,
  "name" text NOT NULL,
  "brief_path" text,
  "status" text DEFAULT 'active' NOT NULL,
  "deliverable" text,
  "created_at" timestamp DEFAULT now(),
  "dissolved_at" timestamp,
  CONSTRAINT "teams_status_check" CHECK ("status" IN ('active','converging','dissolved'))
);

CREATE TABLE "team_members" (
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "agent_name" text NOT NULL,
  "role" text NOT NULL,
  "is_leader" boolean DEFAULT false NOT NULL,
  CONSTRAINT "team_members_team_id_agent_name_pk" PRIMARY KEY("team_id", "agent_name")
);
CREATE UNIQUE INDEX "idx_team_leader" ON "team_members" ("team_id") WHERE is_leader = true;

CREATE TABLE "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "engine_version" text,
  "seed_branch" text,
  "build_timeout_ms" integer,
  "test_timeout_ms" integer,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "projects_id_check" CHECK ("id" ~ '^[a-zA-Z0-9_-]{1,64}$')
);
`;

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DrizzleDb;

  // Apply schema via PGlite's exec (supports multi-statement SQL)
  await client.exec(SCHEMA_DDL);

  return {
    db,
    close: async () => { await client.close(); },
  };
}
