CREATE TABLE "caw"."chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"reply_to" uuid,
	"reply_hop_id" uuid,
	"questions" jsonb,
	"proposal_id" uuid,
	"amendment" jsonb,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_messages_text_length" CHECK (char_length("caw"."chat_messages"."text") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "caw"."proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"status" text NOT NULL,
	"card_ids" uuid[],
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "proposals_status" CHECK ("caw"."proposals"."status" in ('open','accepted','superseded'))
);
--> statement-breakpoint
ALTER TABLE "caw"."hops" DROP CONSTRAINT "hops_outcome";--> statement-breakpoint
ALTER TABLE "caw"."hops" ALTER COLUMN "card_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD COLUMN "located_keys" text[];--> statement-breakpoint
ALTER TABLE "caw"."chat_messages" ADD CONSTRAINT "chat_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."proposals" ADD CONSTRAINT "proposals_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "caw"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "caw"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_card_xor_message" CHECK (("caw"."hops"."card_id" is null) <> ("caw"."hops"."message_id" is null));--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_outcome" CHECK ("caw"."hops"."outcome" is null or "caw"."hops"."outcome" in ('commented','handed_off','status','asked','failed','stopped','interrupted','replied','proposed','amended','proposed_and_amended'));