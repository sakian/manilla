CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"item_id" text NOT NULL,
	"institution_name" text,
	"access_token" text,
	"error_code" text,
	"error_message" text,
	"last_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "bank_connections_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "bank_feed_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"name" text NOT NULL,
	"mask" text,
	"type" text,
	"subtype" text,
	"account_id" uuid,
	"cursor" text
);
--> statement-breakpoint
CREATE TABLE "sync_held_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_account_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"external_id" text NOT NULL,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payee_raw" text NOT NULL,
	"transaction_id" uuid,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_held_rows" ADD CONSTRAINT "sync_held_rows_feed_account_id_bank_feed_accounts_id_fk" FOREIGN KEY ("feed_account_id") REFERENCES "public"."bank_feed_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_held_rows" ADD CONSTRAINT "sync_held_rows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_held_rows" ADD CONSTRAINT "sync_held_rows_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_accounts_provider_idx" ON "bank_feed_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_accounts_account_idx" ON "bank_feed_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sync_held_rows_open_idx" ON "sync_held_rows" USING btree ("resolved_at");