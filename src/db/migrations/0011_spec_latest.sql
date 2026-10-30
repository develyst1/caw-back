CREATE TABLE "caw"."hop_spec" (
	"hop_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"body" jsonb NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"from_cache" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caw"."spec_parts" (
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"revision" integer NOT NULL,
	"body" jsonb NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spec_parts_project_id_key_pk" PRIMARY KEY("project_id","key")
);
--> statement-breakpoint
ALTER TABLE "caw"."cards" ADD COLUMN "anchor_label" text;--> statement-breakpoint
ALTER TABLE "caw"."cards" ADD COLUMN "anchor_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caw"."follow_state" ADD COLUMN "last_pulled_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caw"."follow_state" ADD COLUMN "last_pull_ok" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "caw"."projects" ADD COLUMN "latest_label" jsonb;--> statement-breakpoint
ALTER TABLE "caw"."hop_spec" ADD CONSTRAINT "hop_spec_hop_id_hops_id_fk" FOREIGN KEY ("hop_id") REFERENCES "caw"."hops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."spec_parts" ADD CONSTRAINT "spec_parts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;