CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"transaction_id" uuid,
	"action" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_log_transaction_idx" ON "audit_log" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "audit_log_row_idx" ON "audit_log" USING btree ("row_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");