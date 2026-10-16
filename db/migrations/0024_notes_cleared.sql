CREATE TABLE "conversation_clears" (
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"cleared_through" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_clears_user_id_transaction_id_pk" PRIMARY KEY("user_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_clears" ADD CONSTRAINT "conversation_clears_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;