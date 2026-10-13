-- `caw.events` is append-only (SPEC-A-008 § Data model): the database itself refuses an UPDATE or a DELETE.
CREATE FUNCTION caw.events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'caw.events rows are append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON caw.events
  FOR EACH ROW EXECUTE FUNCTION caw.events_append_only();
