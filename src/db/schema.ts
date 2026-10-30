// Every table of SPEC-A-008 § Data model, in Postgres schema `caw`. Except `events` and `followState`, these are
// projections of `events`: one reducer (src/core/reduce.ts) writes them, so a rebuild from the events equals them.
// No column holds Blueprint spec text — a card's anchor is { key, version }; `title` / `todo` / `note` are CAW's own words.
import { sql } from "drizzle-orm";
import type { CodeMapState } from "../core/reduce"; // a type only: the column holds what the reducer makes
import { bigserial, boolean, check, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const caw = pgSchema("caw");

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const workers = caw.table("workers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(), // unique among the LIVE workers only — see workers_name_live below (v1.14)
  roles: text("roles").array().notNull(), // v1.10: ≥ 1 of the seven, in the order picked (the single `role` column is gone — migration 0005)
  skills: text("skills").array().notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  avatar: jsonb("avatar").$type<{ body: string; color: string; eyes: string }>(), // v1.12: null = not chosen (the screen derives a face; nothing derived is stored)
  deletedAt: at("deleted_at"), // v1.14: set when the operator deletes the worker; the row stays (hops and cards point at it)
  combinedFrom: uuid("combined_from").array(),
  createdAt: at("created_at").notNull(),
}, (t) => [
  uniqueIndex("workers_name_live").on(t.name).where(sql`${t.deletedAt} is null`),
  check("workers_name_length", sql`char_length(${t.name}) between 1 and 40`),
  check("workers_roles", sql`cardinality(${t.roles}) >= 1 AND ${t.roles} <@ ARRAY['PM','BA','SA','FE','BE','QA','other']::text[]`),
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
  workspace: jsonb("workspace").$type<{ roots: string[]; readOnly?: string[] }>().notNull().default({ roots: [] }), // readOnly (v1.16) is optional here: a row from before it has none
  codeMap: jsonb("code_map").$type<CodeMapState>(), // v1.16: null until the entry worker saves one (migration 0009)
  latestLabel: jsonb("latest_label").$type<{ version: number; label: string | null }>(), // REQ-105 (migration 0011): the latest label Blueprint showed; null = none. Replayed state
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
  anchorVersion: integer("anchor_version").notNull(), // from REQ-105 on: the LABEL number when the card was cut (0 = none)
  anchorLabel: text("anchor_label"), // REQ-105 (migration 0011): the label's words then; replayed state
  anchorRevision: integer("anchor_revision").notNull().default(0), // REQ-105: the spec revision the card was cut at; replayed state
  specChangedVersion: integer("spec_changed_version"),
  anchorRemovedRevision: integer("anchor_removed_revision"), // REQ-105 D12 (migration 0012): the spec revision at which the anchor part left the spec; null = it is there; replayed state
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
  allowed: uuid("allowed").array(), // handoff_refused only (v1.3): who the sender could have handed to; null for every other type
  at: at("at").notNull(),
}, (t) => [
  check("notes_type", sql`${t.type} in ('comment','handoff','handoff_refused')`),
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
  check("runs_stop_reason", sql`${t.stopReason} is null or ${t.stopReason} in ('budget_spent','nothing_workable','failed_review_twice','limit_reached','operator_stopped','error','no_progress')`),
  check("runs_report_length", sql`${t.report} is null or char_length(${t.report}) <= 20000`),
]);

// Chat (v1.4, REQ-013): the operator's messages and the entry worker's replies. `replyTo`, `replyHopId` and `proposalId` carry no
// foreign key (hops and proposals point back at messages); the reducer keeps them consistent.
export const chatMessages = caw.table("chat_messages", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  author: text("author").notNull(), // 'operator' | 'worker:<id>'
  text: text("text").notNull(),
  replyTo: uuid("reply_to"),
  replyHopId: uuid("reply_hop_id"), // set when a hop answers this (operator) message
  questions: jsonb("questions"), // null | [{ text, proposedDefault, cases[] }]
  proposalId: uuid("proposal_id"),
  amendment: jsonb("amendment"), // null | { blueprintMessageId, link }
  retryRequestedAt: at("retry_requested_at"), // v1.9: the operator asked for a retry; cleared when a hop starts on the message
  at: at("at").notNull(),
}, (t) => [
  check("chat_messages_text_length", sql`char_length(${t.text}) between 1 and 4000`),
]);

// A proposal of cards from the entry worker's chat hop (v1.4): items are CAW's own words + anchors { key, version } — no spec text.
export const proposals = caw.table("proposals", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  messageId: uuid("message_id").notNull().references(() => chatMessages.id),
  version: integer("version").notNull(),
  items: jsonb("items").notNull(),
  status: text("status").notNull(),
  cardIds: uuid("card_ids").array(),
  createdAt: at("created_at").notNull(),
}, (t) => [
  check("proposals_status", sql`${t.status} in ('open','accepted','superseded')`),
]);

export const hops = caw.table("hops", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  runId: uuid("run_id").references(() => runs.id), // null = a manual hop (v1.1)
  claimedBy: text("claimed_by"), // the runner instance (v1.1)
  cardId: uuid("card_id").references(() => cards.id), // a card hop; null for a chat hop (v1.4)
  messageId: uuid("message_id").references(() => chatMessages.id), // a chat hop; null for a card hop (v1.4)
  locatedKeys: text("located_keys").array(), // union of the keys of every locate in this hop (v1.4 / v1.6); null until the first
  workerId: uuid("worker_id").notNull().references(() => workers.id),
  startedAt: at("started_at").notNull(),
  lastActivityAt: at("last_activity_at").notNull(), // v1.11: = started_at until the first heartbeat
  endedAt: at("ended_at"),
  outcome: text("outcome"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  note: text("note").notNull().default(""),
}, (t) => [
  check("hops_outcome", sql`${t.outcome} is null or ${t.outcome} in ('commented','handed_off','status','asked','failed','stopped','interrupted','replied','proposed','amended','proposed_and_amended')`),
  check("hops_card_xor_message", sql`(${t.cardId} is null) <> (${t.messageId} is null)`),
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
  lastPulledRevision: integer("last_pulled_revision").notNull().default(0), // REQ-105 (migration 0011): the spec revision the pull has got to — TASK-115 moves it
  lastPullOk: boolean("last_pull_ok").notNull().default(true), // REQ-105: whether the last pull reached Blueprint — TASK-115 writes it
});

// Operational, not replayed (REQ-105, SPEC-107 D3): CAW now keeps the last body it read per part, because Blueprint serves no old revision
// and a hop must keep the text it started with (AC-2), and a team must work on the last read when Blueprint is down (AC-5).
export const specParts = caw.table("spec_parts", {
  projectId: uuid("project_id").notNull().references(() => projects.id),
  key: text("key").notNull(),
  revision: integer("revision").notNull(),
  body: jsonb("body").notNull(),
  readAt: at("read_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.key] })]);

// The body a card hop was given at its start (SPEC-107 D5): `card_context` with that hop's X-CAW-Hop returns THIS, even after the hop ended.
export const hopSpec = caw.table("hop_spec", {
  hopId: uuid("hop_id").primaryKey().references(() => hops.id),
  revision: integer("revision").notNull(),
  body: jsonb("body").notNull(),
  readAt: at("read_at").notNull(),
  fromCache: boolean("from_cache").notNull(),
});

// Operational, not replayed (REQ-104): what a hop's CLI showed, rendered and redacted by the runner. Append-only by (hop_id, seq).
export const hopOutput = caw.table("hop_output", {
  hopId: uuid("hop_id").notNull().references(() => hops.id),
  seq: integer("seq").notNull(),
  at: at("at").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull().default(""),
  gapSeconds: integer("gap_seconds"),
}, (t) => [
  primaryKey({ columns: [t.hopId, t.seq] }),
  check("hop_output_kind", sql`${t.kind} in ('line','gap','truncated')`),
  check("hop_output_text_length", sql`char_length(${t.text}) <= 2000`),
  check("hop_output_gap", sql`(${t.kind} = 'gap') = (${t.gapSeconds} is not null)`),
]);
