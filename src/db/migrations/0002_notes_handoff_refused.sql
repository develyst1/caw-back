ALTER TABLE "caw"."notes" DROP CONSTRAINT "notes_type";--> statement-breakpoint
ALTER TABLE "caw"."notes" ADD COLUMN "allowed" uuid[];--> statement-breakpoint
ALTER TABLE "caw"."notes" ADD CONSTRAINT "notes_type" CHECK ("caw"."notes"."type" in ('comment','handoff','handoff_refused'));