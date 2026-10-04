import { gmailApiBase } from "../oauth/google";
import { chunk, mapLimit, requestJson, type HttpDeps } from "./http";
import { HEADER_NAMES, type MailSource, type MessageHeader, type PagesOptions } from "./types";
import { parseAddress } from "./classify";

type GmailList = { messages?: { id: string }[]; nextPageToken?: string };
type GmailMessage = { id: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };

const PAGE_SIZE = 500;
const YIELD_EVERY = 100;
// Sent mail and drafts are the user talking, not services talking to the user. Spam and trash are
// excluded by Gmail's list endpoint unless asked for.
const QUERY = "-in:sent -in:drafts -in:chats";
// With "include spam, trash and sent": only chats stay out. Spam and Trash also need `includeSpamTrash` on the request.
const QUERY_WITH_JUNK = "-in:chats";

export type GmailSourceOptions = HttpDeps & {
  getToken: () => Promise<string>;
  base?: string;
  concurrency?: number;
  /**
   * Requests per second to stay under. Gmail allows about 15,000 quota units a minute per user and a message lookup costs
   * 5, so 40 a second (12,000 a minute) leaves headroom. Infinity turns pacing off.
   */
  requestsPerSecond?: number;
};

/** Reads message headers through the Gmail API with the read-only scope. Bodies are never requested. */
export class GmailSource implements MailSource {
  constructor(private readonly o: GmailSourceOptions) {}

  private nextSlot = 0;

  /** Space requests out, across all concurrent workers, so a fast connection can't burst past Gmail's quota. */
  private async pace(signal?: AbortSignal): Promise<void> {
    const interval = 1000 / (this.o.requestsPerSecond ?? 40);
    if (!(interval > 0) || !Number.isFinite(interval)) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + interval;
    if (wait > 0) {
      signal?.throwIfAborted();
      await (this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
    }
  }

  private get base() {
    return this.o.base ?? gmailApiBase();
  }

  private async get<T>(path: string, signal?: AbortSignal, allow404 = false): Promise<T | null> {
    await this.pace(signal);
    return requestJson<T>(
      `${this.base}${path}`,
      { headers: { authorization: `Bearer ${await this.o.getToken()}` } },
      { fetchImpl: this.o.fetchImpl, sleep: this.o.sleep, allow404, signal },
    );
  }

  async total(since?: Date): Promise<number | null> {
    // The profile only knows the size of the whole mailbox, so a limited scan has no honest estimate.
    if (since) return null;
    const p = await this.get<{ messagesTotal?: number }>("/users/me/profile");
    return p?.messagesTotal ?? null;
  }

  async *pages({ skip, signal, since, includeJunk }: PagesOptions): AsyncIterable<MessageHeader[]> {
    let pageToken: string | undefined;
    const base = includeJunk ? QUERY_WITH_JUNK : QUERY;
    // Gmail's `after:` accepts epoch seconds, which avoids any time-zone guessing.
    const query = since ? `${base} after:${Math.floor(since.getTime() / 1000)}` : base;
    do {
      const params = new URLSearchParams({ maxResults: String(PAGE_SIZE), q: query });
      if (includeJunk) params.set("includeSpamTrash", "true");
      if (pageToken) params.set("pageToken", pageToken);
      const list = (await this.get<GmailList>(`/users/me/messages?${params}`, signal))!;

      const ids = (list.messages ?? []).map((m) => m.id).filter((id) => !skip(id));
      for (const group of chunk(ids, YIELD_EVERY)) {
        signal?.throwIfAborted();
        const fetched = await mapLimit(group, this.o.concurrency ?? 8, (id) => this.metadata(id, signal));
        const headers = fetched.filter((m): m is MessageHeader => m !== null);
        if (headers.length) yield headers;
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
  }

  private async metadata(id: string, signal?: AbortSignal): Promise<MessageHeader | null> {
    const params = new URLSearchParams({ format: "metadata", fields: "id,internalDate,labelIds,payload/headers" });
    for (const h of HEADER_NAMES) params.append("metadataHeaders", h);
    const m = await this.get<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?${params}`, signal, true);
    if (!m) return null; // deleted between list and get

    const h: Record<string, string> = {};
    for (const { name, value } of m.payload?.headers ?? []) h[name.toLowerCase()] ??= value;
    const from = h.from ? parseAddress(h.from) : null;
    const ms = Number(m.internalDate);
    return {
      id: m.id,
      date: new Date(Number.isFinite(ms) && ms > 0 ? ms : 0),
      fromEmail: from?.email ?? "",
      fromName: from?.name ?? null,
      subject: h.subject ?? "",
      listUnsubscribe: h["list-unsubscribe"],
      listUnsubscribePost: h["list-unsubscribe-post"],
      listId: h["list-id"],
      precedence: h.precedence,
      junk: m.labelIds?.includes("SPAM") ?? false,
    };
  }

  async close() {}
}
