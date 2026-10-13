// Every table of SPEC-A-008 § Data model, in Postgres schema `caw`. Except `events` and `followState`, these are
// projections of `events`: one reducer (src/core/reduce.ts) writes them, so a rebuild from the events equals them.
// No column holds Blueprint spec text — a card's anchor is { key, version }; `title` / `todo` / `note` are CAW's own words.
import { sql } from "drizzle-orm";
import { bigserial, check, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const caw = pgSchema("caw");

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const workers = caw.table("workers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  role: text("role").notNull(),
  skills: text("skills").array().notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  combinedFrom: uuid("combined_from").array(),
  createdAt: at("created_at").notNull(),
}, (t) => [
  check("workers_name_length", sql`char_length(${t.name}) between 1 and 40`),
  check("workers_role", sql`${t.role} in ('PM','SA','FE','BE','QA','other')`),
  check("workers_skills_not_empty", sql`cardinality(${t.skills}) >= 1`),
  check("workers_model", sql`${t.model} in ('opus','sonnet','haiku')`),
  check("workers_effort", sql`${t.effort} in ('low','medium','high')`),
]);

export const projects = caw.table("projects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  blueprintProjectId: text("blueprint_project_id").notNull(),
  version: integer("version").notNull(),
  latestSeenVersion: integer("latest_seen_version").notNull(),
  mode: text("mode").notNull().default("manual"),
  hopBudget: integer("hop_budget").notNull().default(0),
  hopsUsed: integer("hops_used").notNull().default(0),
  workspace: jsonb("workspace").$type<{ roots: string[] }>().notNull().default({ roots: [] }),
  entryWorkerId: uuid("entry_worker_id").references(() => workers.id),
  createdAt: at("created_at").notNull(),
}, (t) => [
  unique("projects_blueprint_version").on(t.blueprintProjectId, t.version),
  check("projects_mode", sql`${t.mode} in ('manual','dispatcher')`),
  check("projects_hop_budget", sql`${t.hopBudget} >= 0`),
]);

export const chainMembers = caw.table("chain_members", {
  projectId: uuid("project_id").notNull().references(() => projects.id),
  workerId: uuid("worker_id").notNull().references(() => workers.id),
}, (t) => [primaryKey({ columns: [t.projectId, t.workerId] })]);

export const chainEdges = caw.table("chain_edges", {
  projectId: uuid("project_id").notNull().references(() => projects.id),
  fromWorkerId: uuid("from_worker_id").notNull().references(() => workers.id),
  toWorkerId: uuid("to_worker_id").notNull().references(() => workers.id),
}, (t) => [primaryKey({ columns: [t.projectId, t.fromWorkerId, t.toWorkerId] })]);

export const cards = caw.table("cards", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  number: integer("number").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  todo: text("todo").notNull(),
  status: text("status").notNull(),
  assigneeId: uuid("assignee_id").references(() => workers.id),
  anchorKey: text("anchor_key").notNull(),
  anchorVersion: integer("anchor_version").notNull(),
  specChangedVersion: integer("spec_changed_version"),
  question: jsonb("question"),
  answer: text("answer"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
}, (t) => [
  unique("cards_project_number").on(t.projectId, t.number),
  check("cards_kind", sql`${t.kind} in ('work','question')`),
  check("cards_status", sql`${t.status} in ('todo','doing','review','done','stuck')`),
  check("cards_title_length", sql`char_length(${t.title}) between 1 and 200`),
  check("cards_todo_length", sql`char_length(${t.todo}) <= 8000`),
]);

export const cardDeps = caw.table("card_deps", {
  cardId: uuid("card_id").notNull().references(() => cards.id),
  dependsOnId: uuid("depends_on_id").notNull().references(() => cards.id),
}, (t) => [primaryKey({ columns: [t.cardId, t.dependsOnId] })]);

export const notes = caw.table("notes", {
  id: uuid("id").primaryKey(),
  cardId: uuid("card_id").notNull().references(() => cards.id),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  text: text("text").notNull(),
  fromWorkerId: uuid("from_worker_id").references(() => workers.id),
  toWorkerId: uuid("to_worker_id").references(() => workers.id),
  at: at("at").notNull(),
}, (t) => [
  check("notes_type", sql`${t.type} in ('comment','handoff')`),
  check("notes_text_length", sql`char_length(${t.text}) between 1 and 8000`),
]);

// One open run per project (the partial unique index); `hopBudget` = the hops this run may use. (v1.1)
export const runs = caw.table("runs", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  mode: text("mode").notNull(),
  hopBudget: integer("hop_budget").notNull(),
  startedAt: at("started_at").notNull(),
  endedAt: at("ended_at"),
  stopReason: text("stop_reason"),
  report: text("report"),
}, (t) => [
  uniqueIndex("runs_one_open_per_project").on(t.projectId).where(sql`${t.endedAt} is null`),
  check("runs_mode", sql`${t.mode} in ('manual','dispatcher')`),
  check("runs_hop_budget", sql`${t.hopBudget} >= 0`),
  check("runs_stop_reason", sql`${t.stopReason} is null or ${t.stopReason} in ('budget_spent','nothing_workable','failed_review_twice','limit_reached','operator_stopped','error')`),
  check("runs_report_length", sql`${t.report} is null or char_length(${t.report}) <= 20000`),
]);

export const hops = caw.table("hops", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  runId: uuid("run_id").references(() => runs.id), // null = a manual hop (v1.1)
  claimedBy: text("claimed_by"), // the runner instance (v1.1)
  cardId: uuid("card_id").notNull().references(() => cards.id),
  workerId: uuid("worker_id").notNull().references(() => workers.id),
  startedAt: at("started_at").notNull(),
  endedAt: at("ended_at"),
  outcome: text("outcome"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  note: text("note").notNull().default(""),
}, (t) => [
  check("hops_outcome", sql`${t.outcome} is null or ${t.outcome} in ('commented','handed_off','status','asked','failed','stopped','interrupted')`),
  check("hops_note_length", sql`char_length(${t.note}) <= 2000`),
]);

// Append-only (the db_rules migration refuses UPDATE and DELETE). `projectId` is null for worker-only events,
// which are replayed for every project. No foreign key: the event that creates a project is written before its row.
export const events = caw.table("events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  projectId: uuid("project_id"),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  at: at("at").notNull(),
  data: jsonb("data").notNull(),
});

// Operational, not replayed: where the pull from Blueprint has got to (TASK-A-073).
export const followState = caw.table("follow_state", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id),
  lastPulledVersion: integer("last_pulled_version").notNull(),
  lastPullAt: at("last_pull_at"),
});
