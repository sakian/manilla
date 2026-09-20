CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"model" text NOT NULL,
	"transactions" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"cached_input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_milli_cents" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_suggestion_cache" (
	"payee_key" text PRIMARY KEY NOT NULL,
	"envelope_id" uuid,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_suggestion_cache" ADD CONSTRAINT "ai_suggestion_cache_envelope_id_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_month_idx" ON "ai_calls" USING btree ("month");--> statement-breakpoint
CREATE INDEX "ai_cache_envelope_idx" ON "ai_suggestion_cache" USING btree ("envelope_id");