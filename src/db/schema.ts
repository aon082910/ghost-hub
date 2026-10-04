import {
  boolean,
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

/**
 * Connected mailboxes of any provider. `credential_enc` holds an OAuth refresh token or an IMAP
 * app password, AES-256-GCM encrypted (see lib/crypto).
 */
export const mailboxConnections = pgTable(
  "mailbox_connections",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(), // 'google' | 'microsoft' | 'imap'
    mailbox: text("mailbox").notNull(),
    authType: text("auth_type").notNull(), // 'oauth' | 'password'
    credentialEnc: text("credential_enc").notNull(),
    scopes: text("scopes"),
    imapHost: text("imap_host"),
    imapPort: integer("imap_port"),
    /** Set when the provider rejects the stored credential and the user must reconnect. */
    needsReauth: boolean("needs_reauth").notNull().default(false),
    connectedAt: createdAt().notNull(),
  },
  (t) => [unique("mailbox_connections_provider_mailbox").on(t.provider, t.mailbox)],
);

/** One row per scan run, drives the progress UI and makes scans resumable. */
export const scans = pgTable("scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailbox: text("mailbox").notNull(),
  status: text("status").notNull().default("running"), // running | done | failed | cancelled
  /** Only mail from this date on was scanned. Null means the whole mailbox. */
  since: timestamp("since", { withTimezone: true }),
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
    deletionUrl: text("deletion_url"),
    status: text("status").notNull().default("active"), // active | ignored | deleted
    /** When the user marked the account deleted. Mail after this means the company is still emailing. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [unique("accounts_mailbox_domain").on(t.mailbox, t.domain)],
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
    /** When Ghost-Hub (or the user, by hand) unsubscribed. Mail after this means the sender is ignoring it. */
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  },
  (t) => [unique("newsletters_mailbox_sender").on(t.mailbox, t.senderEmail)],
);

/**
 * Usernames the user has said are their own, to look up on public profile pages. Email addresses are not stored here:
 * only addresses of connected mailboxes (which the user has proven they control) are ever looked up.
 */
export const profileIdentifiers = pgTable(
  "profile_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // username
    value: text("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("profile_identifiers_unique").on(t.type, t.value)],
);

/** Results of looking an identifier up on public sites. Never contains anything but public profile facts. */
export const shadowProfiles = pgTable(
  "shadow_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifierType: text("identifier_type").notNull(), // email | username
    identifier: text("identifier").notNull(),
    site: text("site").notNull(),
    url: text("url"),
    status: text("status").notNull(), // found | not_found | error
    /** Why a check couldn't tell (blocked, rate limited...), or a label for linked accounts. */
    detail: text("detail"),
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

/**
 * Breaches HIBP says a connected mailbox address appears in. Only filled when the user configures an
 * HIBP API key and asks for a check. Without it, breaches are matched to services by domain alone.
 */
export const mailboxBreaches = pgTable(
  "mailbox_breaches",
  {
    mailbox: text("mailbox").notNull(),
    breachName: text("breach_name").notNull(),
  },
  (t) => [unique("mailbox_breaches_pk").on(t.mailbox, t.breachName)],
);

/** When each mailbox was last checked against HIBP, and how it went (also records "checked, found nothing"). */
export const breachChecks = pgTable("breach_checks", {
  mailbox: text("mailbox").primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  breachCount: integer("breach_count").notNull().default(0),
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
