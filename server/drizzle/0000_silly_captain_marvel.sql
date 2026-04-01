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
--> statement-breakpoint
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
	CONSTRAINT "build_history_type_check" CHECK ("build_history"."type" IN ('build', 'test'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"sender" text NOT NULL,
	"content" text NOT NULL,
	"reply_to" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "files" (
	"project_id" text DEFAULT 'default' NOT NULL,
	"path" text NOT NULL,
	"claimant" text,
	"claimed_at" timestamp,
	CONSTRAINT "files_project_id_path_pk" PRIMARY KEY("project_id","path")
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"member" text NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	CONSTRAINT "room_members_room_id_member_pk" PRIMARY KEY("room_id","member")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "rooms_type_check" CHECK ("rooms"."type" IN ('group','direct'))
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" integer NOT NULL,
	"depends_on" integer NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_pk" PRIMARY KEY("task_id","depends_on"),
	CONSTRAINT "task_deps_no_self" CHECK ("task_dependencies"."task_id" != "task_dependencies"."depends_on")
);
--> statement-breakpoint
CREATE TABLE "task_files" (
	"task_id" integer NOT NULL,
	"file_path" text NOT NULL,
	CONSTRAINT "task_files_task_id_file_path_pk" PRIMARY KEY("task_id","file_path")
);
--> statement-breakpoint
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
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('pending','claimed','in_progress','completed','failed','integrated','cycle'))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"role" text NOT NULL,
	"is_leader" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "team_members_team_id_agent_name_pk" PRIMARY KEY("team_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"brief_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"deliverable" text,
	"created_at" timestamp DEFAULT now(),
	"dissolved_at" timestamp,
	CONSTRAINT "teams_status_check" CHECK ("teams"."status" IN ('active','converging','dissolved'))
);
--> statement-breakpoint
CREATE TABLE "ubt_lock" (
	"project_id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"holder" text,
	"acquired_at" timestamp,
	"priority" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "ubt_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"agent" text NOT NULL,
	"priority" integer DEFAULT 0,
	"requested_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_tasks_id_fk" FOREIGN KEY ("depends_on") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_room_id" ON "chat_messages" USING btree ("room_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel" ON "messages" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_id" ON "messages" USING btree ("channel","id");--> statement-breakpoint
CREATE INDEX "idx_messages_claimed" ON "messages" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "idx_task_deps_task" ON "task_dependencies" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_deps_dep" ON "task_dependencies" USING btree ("depends_on");--> statement-breakpoint
CREATE INDEX "idx_task_files_path" ON "task_files" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_priority" ON "tasks" USING btree ("priority","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_team_leader" ON "team_members" USING btree ("team_id") WHERE is_leader = 1;