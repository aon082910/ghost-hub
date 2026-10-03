import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Connected mailbox credentials. The refresh token is AES-256-GCM encrypted (see lib/crypto). */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(), // 'google' | 'microsoft'
    mailbox: text("mailbox").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    scopes: text("scopes").notNull(),
    /** Set when Google rejects the refresh token (e.g. 7-day expiry in Testing mode). */
    needsReauth: boolean("needs_reauth").notNull().default(false),
    connectedAt: createdAt().notNull(),
  },
  (t) => [unique("oauth_tokens_provider_mailbox").on(t.provider, t.mailbox)],
);

/** One row per scan run, drives the progress UI and makes scans resumable. */
export const scans = pgTable("scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailbox: text("mailbox").notNull(),
  status: text("status").notNull().default("running"), // running | done | failed | cancelled
  messagesTotal: integer("messages_total"),
  messagesProcessed: integer("messages_processed").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** Gmail message ids already processed. Ids only, never message content. */
export const messagesSeen = pgTable(
  "messages_seen",
  {
    mailbox: text("mailbox").notNull(),
    messageId: text("message_id").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("messages_seen_pk").on(t.mailbox, t.messageId)],
);

/** A service discovered from sign-up / welcome / receipt emails. */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailbox: text("mailbox").notNull(),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("account"), // account | subscription | receipt | newsletter
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(1),
    breached: boolean("breached").notNull().default(false),
    riskScore: integer("risk_score").notNull().default(0),
    deletionUrl: text("deletion_url"),
    status: text("status").notNull().default("active"), // active | ignored | deleted
  },
  (t) => [
    unique("accounts_mailbox_domain").on(t.mailbox, t.domain),
    index("accounts_risk_idx").on(t.riskScore),
  ],
);

export const newsletters = pgTable(
  "newsletters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailbox: text("mailbox").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name"),
    domain: text("domain").notNull(),
    listUnsubscribe: text("list_unsubscribe"), // raw List-Unsubscribe header value
    oneClick: boolean("one_click").notNull().default(false), // List-Unsubscribe-Post present (RFC 8058)
    messageCount: integer("message_count").notNull().default(1),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("subscribed"), // subscribed | unsubscribed | failed | ignored
  },
  (t) => [unique("newsletters_mailbox_sender").on(t.mailbox, t.senderEmail)],
);

/** Profiles found for the user's own email / phone / username. */
export const shadowProfiles = pgTable(
  "shadow_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifierType: text("identifier_type").notNull(), // email | phone | username
    identifier: text("identifier").notNull(),
    site: text("site").notNull(),
    url: text("url"),
    status: text("status").notNull(), // found | not_found | error
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("shadow_profiles_unique").on(t.identifierType, t.identifier, t.site)],
);

/** Cache of the Have I Been Pwned public breach list. */
export const breaches = pgTable("breaches", {
  name: text("name").primaryKey(),
  title: text("title").notNull(),
  domain: text("domain"),
  breachDate: text("breach_date"),
  pwnCount: integer("pwn_count"),
  dataClasses: jsonb("data_classes").$type<string[]>().notNull().default([]),
  isVerified: boolean("is_verified").notNull().default(true),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Audit log of review-first actions: nothing executes until status = approved. */
export const actions = pgTable("actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // unsubscribe | delete_account | ...
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | executed | failed
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});
