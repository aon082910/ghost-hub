/**
 * What a scan learns about one message. Headers only: no body is ever fetched, and the subject is
 * used for classification in memory and then discarded (never stored).
 */
export type MessageHeader = {
  /** Stable, provider-unique id. Used to skip messages already scanned. */
  id: string;
  date: Date;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  listId?: string;
  precedence?: string;
};

export type PagesOptions = {
  /** True for ids that were scanned before, so sources can avoid fetching them. */
  skip: (id: string) => boolean;
  signal?: AbortSignal;
  /** Only read mail received on or after this date. Left out means the whole mailbox. */
  since?: Date;
  /** Also read Spam/Junk, Trash, Sent and Drafts, which are skipped by default. */
  includeJunk?: boolean;
};

/** A mailbox we can read message headers from, newest first. */
export interface MailSource {
  /** Rough number of messages (from `since` on, if given), for the progress bar. Null if unknown. */
  total(since?: Date, includeJunk?: boolean): Promise<number | null>;
  /** Pages of headers (not-skipped messages only). */
  pages(opts: PagesOptions): AsyncIterable<MessageHeader[]>;
  close(): Promise<void>;
}

export const HEADER_NAMES = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Precedence"] as const;
