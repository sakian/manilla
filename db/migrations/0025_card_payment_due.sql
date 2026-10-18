ALTER TABLE "accounts" ADD COLUMN "statement_day" smallint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "payment_due_day" smallint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "payment_marked_for" date;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "bills" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_payment_days" CHECK (("accounts"."statement_day" is null) = ("accounts"."payment_due_day" is null)
        and coalesce("accounts"."statement_day" between 1 and 31, true)
        and coalesce("accounts"."payment_due_day" between 1 and 31, true));