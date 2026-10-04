-- Who created a transaction or an envelope move (NF-2). The audit trigger
-- records changes, not arrivals, and moves are never changed - undo is another
-- move - so without these nothing said who moved money. Read the same
-- transaction-local `manilla.actor` the trigger reads (0017), forgiving it the
-- same way: unset or unreadable is null, never a refused write. STABLE, so
-- adding the columns gives existing rows null without rewriting either table.
CREATE OR REPLACE FUNCTION manilla_actor_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (nullif(current_setting('manilla.actor', true), '')::jsonb ->> 'id')::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION manilla_actor_name() RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN nullif(current_setting('manilla.actor', true), '')::jsonb ->> 'name';
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER TABLE "envelope_moves" ADD COLUMN "created_by_id" uuid DEFAULT manilla_actor_id();--> statement-breakpoint
ALTER TABLE "envelope_moves" ADD COLUMN "created_by_name" text DEFAULT manilla_actor_name();--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "created_by_id" uuid DEFAULT manilla_actor_id();--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "created_by_name" text DEFAULT manilla_actor_name();