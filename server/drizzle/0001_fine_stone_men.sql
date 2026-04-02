DROP INDEX "idx_tasks_priority";--> statement-breakpoint
DROP INDEX "idx_team_leader";--> statement-breakpoint
ALTER TABLE "team_members" ALTER COLUMN "is_leader" SET DATA TYPE boolean;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_chat_messages_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_priority" ON "tasks" USING btree ("priority" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_team_leader" ON "team_members" USING btree ("team_id") WHERE is_leader = true;