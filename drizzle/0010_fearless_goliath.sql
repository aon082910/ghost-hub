ALTER TABLE "accounts" ADD COLUMN "spam_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "spam_count" integer DEFAULT 0 NOT NULL;