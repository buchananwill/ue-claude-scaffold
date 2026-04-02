ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_reply_to_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_chat_messages_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;