CREATE TABLE "transaction_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"author_id" uuid DEFAULT manilla_actor_id(),
	"author_name" text DEFAULT manilla_actor_name(),
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "handed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_messages" ADD CONSTRAINT "transaction_messages_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_messages_transaction_idx" ON "transaction_messages" USING btree ("transaction_id","created_at");--> statement-breakpoint
-- Each note becomes the first message of its transaction's thread, in the
-- name of whoever last wrote it as the audit trail recorded, or else whoever
-- recorded the transaction, and dated then.
INSERT INTO "transaction_messages" ("transaction_id", "author_id", "author_name", "body", "created_at")
SELECT t."id",
  coalesce(w."actor_id", t."created_by_id"),
  coalesce(w."actor_name", t."created_by_name"),
  t."note",
  coalesce(w."at", t."created_at")
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT a."actor_id", a."actor_name", a."at" FROM "audit_log" a
  WHERE a."table_name" = 'transactions' AND a."row_id" = t."id" AND a."after" ->> 'note' = t."note"
  ORDER BY a."id" DESC LIMIT 1
) w ON true
WHERE t."note" IS NOT NULL AND btrim(t."note") <> '';--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "note";--> statement-breakpoint
-- Edits and removals of messages go in the audit trail too, under the
-- transaction they are about, as a note's did when it was a column.
CREATE OR REPLACE FUNCTION manilla_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb;
  changed_before jsonb := '{}'::jsonb;
  changed_after jsonb := '{}'::jsonb;
  col text;
  owner uuid;
  actor jsonb;
  actor_id uuid;
  actor_name text;
BEGIN
  BEGIN
    actor := nullif(current_setting('manilla.actor', true), '')::jsonb;
    actor_id := (actor ->> 'id')::uuid;
    actor_name := actor ->> 'name';
  EXCEPTION WHEN others THEN
    actor_id := NULL;
    actor_name := NULL;
  END;

  owner := CASE TG_TABLE_NAME
    WHEN 'transactions' THEN (old_row ->> 'id')::uuid
    WHEN 'txn_lines' THEN (old_row ->> 'transaction_id')::uuid
    WHEN 'transaction_messages' THEN (old_row ->> 'transaction_id')::uuid
  END;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, row_id, transaction_id, action, before, actor_id, actor_name)
    VALUES (TG_TABLE_NAME, (old_row ->> 'id')::uuid, owner, 'delete', old_row, actor_id, actor_name);
    RETURN OLD;
  END IF;

  new_row := to_jsonb(NEW);
  FOR col IN SELECT jsonb_object_keys(new_row) LOOP
    CONTINUE WHEN col = 'updated_at';
    IF new_row -> col IS DISTINCT FROM old_row -> col THEN
      changed_before := changed_before || jsonb_build_object(col, old_row -> col);
      changed_after := changed_after || jsonb_build_object(col, new_row -> col);
    END IF;
  END LOOP;

  IF changed_before <> '{}'::jsonb THEN
    INSERT INTO audit_log (table_name, row_id, transaction_id, action, before, after, actor_id, actor_name)
    VALUES (TG_TABLE_NAME, (new_row ->> 'id')::uuid, owner, 'update', changed_before, changed_after, actor_id, actor_name);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transaction_messages_audit AFTER UPDATE OR DELETE ON transaction_messages
  FOR EACH ROW EXECUTE FUNCTION manilla_audit();
