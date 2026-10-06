ALTER TABLE "push_subscriptions" ADD COLUMN "handed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "handed_to_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "handed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "review_opens_on" text DEFAULT 'all' NOT NULL;