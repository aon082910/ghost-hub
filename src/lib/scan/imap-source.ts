import { chunk } from "./http";
import { parseHeaderBlock } from "./classify";
import { HEADER_NAMES, type MailSource, type MessageHeader, type PagesOptions } from "./types";

export type FetchedMessage = {
  uid: number;
  envelope?: { date?: Date; subject?: string; from?: { name?: string; address?: string }[] };
  internalDate?: Date | string;
  headers?: Buffer;
};

/** The slice of ImapFlow the scanner uses, so tests can substitute a fake. */
export type ImapScanClient = {
  connect(): Promise<unknown>;
  list(): Promise<{ path: string; specialUse?: string; flags?: Set<string> }[]>;
  status(path: string, query: { messages: true }): Promise<false | { messages?: number }>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: false | { uidValidity?: bigint | number | string };
  search(query: { all: true } | { since: Date }, opts: { uid: true }): Promise<number[] | false>;
  fetch(
    range: string,
    query: { uid: true; envelope: true; internalDate: true; headers: string[] },
    opts: { uid: true },
  ): AsyncIterable<FetchedMessage>;
  logout(): Promise<unknown>;
  close(): void;
};

const FETCH_CHUNK = 100;
const SKIPPED_SPECIAL_USE = new Set(["\\Junk", "\\Trash", "\\Sent", "\\Drafts"]);
// Not every server sets special-use flags (Yahoo's spam folder is "Bulk"), so fall back to the name.
const SKIPPED_NAME = /^(?:spam|junk|bulk(?: mail)?|trash|deleted(?: items| messages)?|sent(?: items| mail| messages)?|drafts?)$/i;

export const isSkippedFolder = (f: { path: string; specialUse?: string; flags?: Set<string> }) =>
  (f.specialUse !== undefined && SKIPPED_SPECIAL_USE.has(f.specialUse)) ||
  f.flags?.has("\\Noselect") === true ||
  f.flags?.has("\\NonExistent") === true ||
  SKIPPED_NAME.test(f.path.split(/[/.]/).pop() ?? f.path);

/** Reads message headers over IMAP, one folder at a time, newest first. Bodies are never requested. */
export class ImapSource implements MailSource {
  private connected = false;
  private folders: Promise<{ path: string }[]> | null = null;

  constructor(private readonly client: ImapScanClient) {}

  private async ensureConnected() {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  private listFolders() {
    this.folders ??= (async () => {
      await this.ensureConnected();
      return (await this.client.list()).filter((f) => !isSkippedFolder(f));
    })();
    return this.folders;
  }

  async total(since?: Date): Promise<number | null> {
    let sum = 0;
    for (const f of await this.listFolders()) {
      if (since) {
        const lock = await this.client.getMailboxLock(f.path);
        try {
          sum += ((await this.client.search({ since }, { uid: true })) || []).length;
        } finally {
          lock.release();
        }
      } else {
        const s = await this.client.status(f.path, { messages: true });
        sum += (s && s.messages) || 0;
      }
    }
    return sum;
  }

  async *pages({ skip, signal, since }: PagesOptions): AsyncIterable<MessageHeader[]> {
    for (const folder of await this.listFolders()) {
      signal?.throwIfAborted();
      const lock = await this.client.getMailboxLock(folder.path);
      try {
        // uidValidity changes if the server renumbers a folder, which correctly invalidates old ids.
        const validity = String(this.client.mailbox ? (this.client.mailbox.uidValidity ?? 0) : 0);
        const query = since ? { since } : { all: true as const };
        const uids = ((await this.client.search(query, { uid: true })) || []).sort((a, b) => b - a);

        for (const group of chunk(uids, FETCH_CHUNK)) {
          signal?.throwIfAborted();
          const wanted = group.filter((uid) => !skip(idFor(folder.path, validity, uid)));
          if (!wanted.length) continue;

          const headers: MessageHeader[] = [];
          for await (const m of this.client.fetch(
            wanted.join(","),
            { uid: true, envelope: true, internalDate: true, headers: [...HEADER_NAMES] },
            { uid: true },
          )) {
            headers.push(toHeader(idFor(folder.path, validity, m.uid), m));
          }
          if (headers.length) yield headers;
        }
      } finally {
        lock.release();
      }
    }
  }

  async close() {
    if (!this.connected) return;
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

const idFor = (path: string, validity: string, uid: number) => `${path}:${validity}:${uid}`;

function toHeader(id: string, m: FetchedMessage): MessageHeader {
  const raw = m.headers ? parseHeaderBlock(m.headers.toString("utf8")) : {};
  const from = m.envelope?.from?.[0];
  const when = m.envelope?.date ?? m.internalDate;
  const t = when ? new Date(when).getTime() : NaN;
  return {
    id,
    date: new Date(Number.isFinite(t) ? t : 0),
    fromEmail: (from?.address ?? "").toLowerCase(),
    fromName: from?.name?.trim() || null,
    subject: m.envelope?.subject ?? raw.subject ?? "",
    listUnsubscribe: raw["list-unsubscribe"],
    listUnsubscribePost: raw["list-unsubscribe-post"],
    listId: raw["list-id"],
    precedence: raw.precedence,
  };
}
