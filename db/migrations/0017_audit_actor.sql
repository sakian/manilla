-- Who made each change in the audit trail (NF-2). The app sets `manilla.actor`
-- as jsonb text, local to the transaction, before any write (db/client.ts and
-- src/audit/actor.ts); this reads it back. Unset - a migration, a statement
-- typed into psql - leaves both columns null rather than guessing, and a value
-- that does not parse is treated the same way: a trail that refuses the change
-- would be worse than one that cannot say who made it.
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

  -- The transaction a row belongs to, so one transaction's history includes
  -- its envelope lines. Read through jsonb because the three tables differ.
  owner := CASE TG_TABLE_NAME
    WHEN 'transactions' THEN (old_row ->> 'id')::uuid
    WHEN 'txn_lines' THEN (old_row ->> 'transaction_id')::uuid
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
