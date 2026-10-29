CREATE TABLE "caw"."hop_output" (
	"hop_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"gap_seconds" integer,
	CONSTRAINT "hop_output_hop_id_seq_pk" PRIMARY KEY("hop_id","seq"),
	CONSTRAINT "hop_output_kind" CHECK ("caw"."hop_output"."kind" in ('line','gap','truncated')),
	CONSTRAINT "hop_output_text_length" CHECK (char_length("caw"."hop_output"."text") <= 2000),
	CONSTRAINT "hop_output_gap" CHECK (("caw"."hop_output"."kind" = 'gap') = ("caw"."hop_output"."gap_seconds" is not null))
);
--> statement-breakpoint
ALTER TABLE "caw"."hop_output" ADD CONSTRAINT "hop_output_hop_id_hops_id_fk" FOREIGN KEY ("hop_id") REFERENCES "caw"."hops"("id") ON DELETE no action ON UPDATE no action;