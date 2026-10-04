CREATE TABLE "breach_checks" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"breach_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_breaches" (
	"mailbox" text NOT NULL,
	"breach_name" text NOT NULL,
	CONSTRAINT "mailbox_breaches_pk" UNIQUE("mailbox","breach_name")
);
--> statement-breakpoint
DROP INDEX "accounts_risk_idx";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "breached";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "risk_score";