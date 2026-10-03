-- The audit trail (NF-2, #8): every update to and deletion of a row that money
-- is derived from, recorded by the database in the same transaction as the
-- change. A trigger rather than application code, so no write path - today's
-- fourteen, next year's, or a statement typed into psql - can forget to.
--
-- An update records only the columns that changed, as they were and as they
-- became; `updated_at` alone changing is not a change worth a row. A deletion
-- records the whole row. Inserts are not recorded: the row says when it came.
CREATE OR REPLACE FUNCTION manilla_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb;
  changed_before jsonb := '{}'::jsonb;
  changed_after jsonb := '{}'::jsonb;
  col text;
  owner uuid;
BEGIN
  -- The transaction a row belongs to, so one transaction's history includes
  -- its envelope lines. Read through jsonb because the three tables differ.
  owner := CASE TG_TABLE_NAME
    WHEN 'transactions' THEN (old_row ->> 'id')::uuid
    WHEN 'txn_lines' THEN (old_row ->> 'transaction_id')::uuid
  END;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, row_id, transaction_id, action, before)
    VALUES (TG_TABLE_NAME, (old_row ->> 'id')::uuid, owner, 'delete', old_row);
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
    INSERT INTO audit_log (table_name, row_id, transaction_id, action, before, after)
    VALUES (TG_TABLE_NAME, (new_row ->> 'id')::uuid, owner, 'update', changed_before, changed_after);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transactions_audit AFTER UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION manilla_audit();
--> statement-breakpoint
CREATE TRIGGER txn_lines_audit AFTER UPDATE OR DELETE ON txn_lines
  FOR EACH ROW EXECUTE FUNCTION manilla_audit();
--> statement-breakpoint
CREATE TRIGGER envelope_moves_audit AFTER UPDATE OR DELETE ON envelope_moves
  FOR EACH ROW EXECUTE FUNCTION manilla_audit();
