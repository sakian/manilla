ALTER TABLE "transactions" ADD COLUMN "note" text;--> statement-breakpoint
-- A memo typed by hand, or carried over from the old app's Notes column, was
-- always the user's own note: it moves across. A bank's memo stays a memo.
UPDATE "transactions" SET "note" = "memo", "memo" = NULL WHERE "source" IN ('manual', 'goodbudget') AND "memo" IS NOT NULL;
