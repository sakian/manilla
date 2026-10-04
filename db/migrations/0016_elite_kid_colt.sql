ALTER TABLE "audit_log" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_name" text;