CREATE SCHEMA IF NOT EXISTS caw;
--> statement-breakpoint
CREATE TABLE "caw"."card_deps" (
	"card_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	CONSTRAINT "card_deps_card_id_depends_on_id_pk" PRIMARY KEY("card_id","depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "caw"."cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"todo" text NOT NULL,
	"status" text NOT NULL,
	"assignee_id" uuid,
	"anchor_key" text NOT NULL,
	"anchor_version" integer NOT NULL,
	"spec_changed_version" integer,
	"question" jsonb,
	"answer" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cards_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "cards_kind" CHECK ("caw"."cards"."kind" in ('work','question')),
	CONSTRAINT "cards_status" CHECK ("caw"."cards"."status" in ('todo','doing','review','done','stuck')),
	CONSTRAINT "cards_title_length" CHECK (char_length("caw"."cards"."title") between 1 and 200),
	CONSTRAINT "cards_todo_length" CHECK (char_length("caw"."cards"."todo") <= 8000)
);
--> statement-breakpoint
CREATE TABLE "caw"."chain_edges" (
	"project_id" uuid NOT NULL,
	"from_worker_id" uuid NOT NULL,
	"to_worker_id" uuid NOT NULL,
	CONSTRAINT "chain_edges_project_id_from_worker_id_to_worker_id_pk" PRIMARY KEY("project_id","from_worker_id","to_worker_id")
);
--> statement-breakpoint
CREATE TABLE "caw"."chain_members" (
	"project_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	CONSTRAINT "chain_members_project_id_worker_id_pk" PRIMARY KEY("project_id","worker_id")
);
--> statement-breakpoint
CREATE TABLE "caw"."events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caw"."follow_state" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"last_pulled_version" integer NOT NULL,
	"last_pull_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "caw"."hops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"claimed_by" text,
	"card_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "hops_outcome" CHECK ("caw"."hops"."outcome" is null or "caw"."hops"."outcome" in ('commented','handed_off','status','asked','failed','stopped','interrupted')),
	CONSTRAINT "hops_note_length" CHECK (char_length("caw"."hops"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "caw"."notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"text" text NOT NULL,
	"from_worker_id" uuid,
	"to_worker_id" uuid,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "notes_type" CHECK ("caw"."notes"."type" in ('comment','handoff')),
	CONSTRAINT "notes_text_length" CHECK (char_length("caw"."notes"."text") between 1 and 8000)
);
--> statement-breakpoint
CREATE TABLE "caw"."projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"blueprint_project_id" text NOT NULL,
	"version" integer NOT NULL,
	"latest_seen_version" integer NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"hop_budget" integer DEFAULT 0 NOT NULL,
	"hops_used" integer DEFAULT 0 NOT NULL,
	"workspace" jsonb DEFAULT '{"roots":[]}'::jsonb NOT NULL,
	"entry_worker_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "projects_blueprint_version" UNIQUE("blueprint_project_id","version"),
	CONSTRAINT "projects_mode" CHECK ("caw"."projects"."mode" in ('manual','dispatcher')),
	CONSTRAINT "projects_hop_budget" CHECK ("caw"."projects"."hop_budget" >= 0)
);
--> statement-breakpoint
CREATE TABLE "caw"."runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"hop_budget" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"stop_reason" text,
	"report" text,
	CONSTRAINT "runs_mode" CHECK ("caw"."runs"."mode" in ('manual','dispatcher')),
	CONSTRAINT "runs_hop_budget" CHECK ("caw"."runs"."hop_budget" >= 0),
	CONSTRAINT "runs_stop_reason" CHECK ("caw"."runs"."stop_reason" is null or "caw"."runs"."stop_reason" in ('budget_spent','nothing_workable','failed_review_twice','limit_reached','operator_stopped','error')),
	CONSTRAINT "runs_report_length" CHECK ("caw"."runs"."report" is null or char_length("caw"."runs"."report") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "caw"."workers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"skills" text[] NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"combined_from" uuid[],
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workers_name_unique" UNIQUE("name"),
	CONSTRAINT "workers_name_length" CHECK (char_length("caw"."workers"."name") between 1 and 40),
	CONSTRAINT "workers_role" CHECK ("caw"."workers"."role" in ('PM','SA','FE','BE','QA','other')),
	CONSTRAINT "workers_skills_not_empty" CHECK (cardinality("caw"."workers"."skills") >= 1),
	CONSTRAINT "workers_model" CHECK ("caw"."workers"."model" in ('opus','sonnet','haiku')),
	CONSTRAINT "workers_effort" CHECK ("caw"."workers"."effort" in ('low','medium','high'))
);
--> statement-breakpoint
ALTER TABLE "caw"."card_deps" ADD CONSTRAINT "card_deps_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "caw"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."card_deps" ADD CONSTRAINT "card_deps_depends_on_id_cards_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "caw"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."cards" ADD CONSTRAINT "cards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."cards" ADD CONSTRAINT "cards_assignee_id_workers_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."chain_edges" ADD CONSTRAINT "chain_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."chain_edges" ADD CONSTRAINT "chain_edges_from_worker_id_workers_id_fk" FOREIGN KEY ("from_worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."chain_edges" ADD CONSTRAINT "chain_edges_to_worker_id_workers_id_fk" FOREIGN KEY ("to_worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."chain_members" ADD CONSTRAINT "chain_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."chain_members" ADD CONSTRAINT "chain_members_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."follow_state" ADD CONSTRAINT "follow_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "caw"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "caw"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."hops" ADD CONSTRAINT "hops_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."notes" ADD CONSTRAINT "notes_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "caw"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."notes" ADD CONSTRAINT "notes_from_worker_id_workers_id_fk" FOREIGN KEY ("from_worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."notes" ADD CONSTRAINT "notes_to_worker_id_workers_id_fk" FOREIGN KEY ("to_worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."projects" ADD CONSTRAINT "projects_entry_worker_id_workers_id_fk" FOREIGN KEY ("entry_worker_id") REFERENCES "caw"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caw"."runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "caw"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_open_per_project" ON "caw"."runs" USING btree ("project_id") WHERE "caw"."runs"."ended_at" is null;