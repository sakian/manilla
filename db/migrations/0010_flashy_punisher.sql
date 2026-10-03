-- The old index let an envelope collect several default plans, because no two
-- null months were equal to it. One has to go before the constraint can exist.
-- Default rows were only ever inserted, never updated, so the one stored last
-- physically is the latest the user set - unless a vacuum let a later insert
-- reuse earlier space, which is the best this can do without a timestamp.
DELETE FROM "budget_lines" "a" USING "budget_lines" "b" WHERE "a"."envelope_id" = "b"."envelope_id" AND "a"."month" IS NOT DISTINCT FROM "b"."month" AND "a"."ctid" < "b"."ctid";--> statement-breakpoint
DROP INDEX "budget_lines_envelope_month_idx";--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_envelope_month_key" UNIQUE NULLS NOT DISTINCT("envelope_id","month");
