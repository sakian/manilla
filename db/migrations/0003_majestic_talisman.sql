ALTER TABLE "envelope_moves" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "envelope_moves_external_idx" ON "envelope_moves" USING btree ("external_id");