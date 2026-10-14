ALTER TABLE "caw"."hops" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
UPDATE "caw"."hops" SET "last_activity_at" = "started_at";--> statement-breakpoint
ALTER TABLE "caw"."hops" ALTER COLUMN "last_activity_at" SET NOT NULL;
