ALTER TABLE "caw"."workers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "caw"."workers" DROP CONSTRAINT "workers_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "workers_name_live" ON "caw"."workers" ("name") WHERE "deleted_at" IS NULL;
