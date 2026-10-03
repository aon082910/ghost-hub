CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'account' NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 1 NOT NULL,
	"breached" boolean DEFAULT false NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"deletion_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "accounts_mailbox_domain" UNIQUE("mailbox","domain")
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "breaches" (
	"name" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"domain" text,
	"breach_date" text,
	"pwn_count" integer,
	"data_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_verified" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages_seen" (
	"mailbox" text NOT NULL,
	"message_id" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_seen_pk" UNIQUE("mailbox","message_id")
);
--> statement-breakpoint
CREATE TABLE "newsletters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"sender_email" text NOT NULL,
	"sender_name" text,
	"domain" text NOT NULL,
	"list_unsubscribe" text,
	"one_click" boolean DEFAULT false NOT NULL,
	"message_count" integer DEFAULT 1 NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'subscribed' NOT NULL,
	CONSTRAINT "newsletters_mailbox_sender" UNIQUE("mailbox","sender_email")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"mailbox" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_provider_mailbox" UNIQUE("provider","mailbox")
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"messages_total" integer,
	"messages_processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shadow_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_type" text NOT NULL,
	"identifier" text NOT NULL,
	"site" text NOT NULL,
	"url" text,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_profiles_unique" UNIQUE("identifier_type","identifier","site")
);
--> statement-breakpoint
CREATE INDEX "accounts_risk_idx" ON "accounts" USING btree ("risk_score");