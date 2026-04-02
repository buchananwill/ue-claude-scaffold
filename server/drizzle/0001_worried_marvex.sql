CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"engine_version" text,
	"seed_branch" text,
	"build_timeout_ms" integer,
	"test_timeout_ms" integer,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "projects_id_check" CHECK ("projects"."id" ~ '^[a-zA-Z0-9_-]{1,64}$')
);
