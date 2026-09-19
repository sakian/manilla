CREATE TYPE "public"."account_kind" AS ENUM('chequing', 'savings', 'credit_card', 'cash', 'line_of_credit');--> statement-breakpoint
CREATE TYPE "public"."external_id_kind" AS ENUM('fitid', 'aggregator', 'goodbudget');--> statement-breakpoint
CREATE TYPE "public"."move_kind" AS ENUM('allocation', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."suggestion_layer" AS ENUM('rule', 'history', 'ai');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('spending', 'account_transfer');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('manual', 'file_import', 'bank_sync', 'goodbudget', 'opening_balance');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending_review', 'confirmed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"external_account_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"month" date,
	"planned_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "envelope_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "envelope_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_envelope_id" uuid NOT NULL,
	"to_envelope_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" date NOT NULL,
	"kind" "move_kind" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"carry_over" boolean DEFAULT true NOT NULL,
	"is_unallocated" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "transaction_source" NOT NULL,
	"filename" text,
	"account_id" uuid,
	"added_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contains" text NOT NULL,
	"envelope_id" uuid NOT NULL,
	"min_cents" bigint,
	"max_cents" bigint,
	"account_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"envelope_id" uuid,
	"layer" "suggestion_layer" NOT NULL,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"accepted_envelope_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_external_ids" (
	"transaction_id" uuid NOT NULL,
	"kind" "external_id_kind" NOT NULL,
	"value" text NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "transaction_external_ids_account_id_kind_value_pk" PRIMARY KEY("account_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payee_raw" text NOT NULL,
	"payee_key" text NOT NULL,
	"memo" text,
	"check_number" text,
	"kind" "transaction_kind" DEFAULT 'spending' NOT NULL,
	"status" "transaction_status" DEFAULT 'pending_review' NOT NULL,
	"source" "transaction_source" NOT NULL,
	"import_batch_id" uuid,
	"transfer_pair_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txn_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"envelope_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_moves" ADD CONSTRAINT "envelope_moves_from_envelope_id_envelopes_id_fk" FOREIGN KEY ("from_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_moves" ADD CONSTRAINT "envelope_moves_to_envelope_id_envelopes_id_fk" FOREIGN KEY ("to_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_group_id_envelope_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."envelope_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_accepted_envelope_id_envelopes_id_fk" FOREIGN KEY ("accepted_envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_external_ids" ADD CONSTRAINT "transaction_external_ids_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_external_ids" ADD CONSTRAINT "transaction_external_ids_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn_lines" ADD CONSTRAINT "txn_lines_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn_lines" ADD CONSTRAINT "txn_lines_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_external_idx" ON "accounts" USING btree ("external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_envelope_month_idx" ON "budget_lines" USING btree ("envelope_id","month");--> statement-breakpoint
CREATE INDEX "credentials_user_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "envelope_moves_date_idx" ON "envelope_moves" USING btree ("date");--> statement-breakpoint
CREATE INDEX "envelope_moves_from_idx" ON "envelope_moves" USING btree ("from_envelope_id");--> statement-breakpoint
CREATE INDEX "envelope_moves_to_idx" ON "envelope_moves" USING btree ("to_envelope_id");--> statement-breakpoint
CREATE INDEX "envelopes_group_idx" ON "envelopes" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "envelopes_one_unallocated_idx" ON "envelopes" USING btree ("is_unallocated") WHERE "envelopes"."is_unallocated";--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rules_position_idx" ON "rules" USING btree ("position");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_transaction_idx" ON "suggestions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "external_ids_transaction_idx" ON "transaction_external_ids" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_account_date_idx" ON "transactions" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "transactions_date_idx" ON "transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transactions_payee_key_idx" ON "transactions" USING btree ("payee_key");--> statement-breakpoint
CREATE INDEX "transactions_batch_idx" ON "transactions" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "txn_lines_transaction_idx" ON "txn_lines" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "txn_lines_envelope_idx" ON "txn_lines" USING btree ("envelope_id");