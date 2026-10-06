ALTER TABLE "push_subscriptions" ADD COLUMN "review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "changes" boolean DEFAULT false NOT NULL;