ALTER TABLE "caw"."workers" ADD COLUMN "roles" text[];--> statement-breakpoint
UPDATE "caw"."workers" SET "roles" = ARRAY["role"];--> statement-breakpoint
ALTER TABLE "caw"."workers" ALTER COLUMN "roles" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caw"."workers" DROP CONSTRAINT "workers_role";--> statement-breakpoint
ALTER TABLE "caw"."workers" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "caw"."workers" ADD CONSTRAINT "workers_roles" CHECK (cardinality("roles") >= 1 AND "roles" <@ ARRAY['PM','BA','SA','FE','BE','QA','other']::text[]);
