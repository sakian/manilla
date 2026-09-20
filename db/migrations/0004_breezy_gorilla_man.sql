ALTER TABLE "rules" ALTER COLUMN "envelope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "transfer_account_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_one_outcome" CHECK (("rules"."envelope_id" is null) <> ("rules"."transfer_account_id" is null));