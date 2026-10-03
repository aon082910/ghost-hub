CREATE TABLE "mailbox_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"mailbox" text NOT NULL,
	"auth_type" text NOT NULL,
	"credential_enc" text NOT NULL,
	"scopes" text,
	"imap_host" text,
	"imap_port" integer,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_connections_provider_mailbox" UNIQUE("provider","mailbox")
);

--> statement-breakpoint
-- Carry existing connections over from the old single-provider table.
INSERT INTO "mailbox_connections" ("provider", "mailbox", "auth_type", "credential_enc", "scopes", "needs_reauth", "created_at")
SELECT "provider", "mailbox", 'oauth', "refresh_token_enc", "scopes", "needs_reauth", "created_at" FROM "oauth_tokens";
