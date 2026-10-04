CREATE TABLE "profile_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_identifiers_unique" UNIQUE("type","value")
);
--> statement-breakpoint
ALTER TABLE "shadow_profiles" ADD COLUMN "detail" text;