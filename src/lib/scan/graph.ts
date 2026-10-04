import { graphApiBase } from "../oauth/microsoft";
import { requestJson, type HttpDeps } from "./http";
import type { MailSource, MessageHeader, PagesOptions } from "./types";

type GraphMessage = {
  id: string;
  receivedDateTime?: string;
  subject?: string | null;
  parentFolderId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  internetMessageHeaders?: { name: string; value: string }[];
};
type GraphPage = { value?: GraphMessage[]; "@odata.nextLink"?: string };

const PAGE_SIZE = 50; // each message carries its full header list, so keep pages modest
// Mail the user sent or discarded isn't a service talking to them.
const SKIPPED_FOLDERS = ["junkemail", "deleteditems", "sentitems", "drafts"];

export type GraphSourceOptions = HttpDeps & { getToken: () => Promise<string>; base?: string };

/** Reads message headers through Microsoft Graph with `Mail.Read`. Bodies are never requested. */
export class GraphSource implements MailSource {
  private skippedFolderIds: Promise<Set<string>> | null = null;

  constructor(private readonly o: GraphSourceOptions) {}

  private get base() {
    return this.o.base ?? graphApiBase();
  }

  /** Throws if a server-provided URL points anywhere other than Graph, so the bearer token can't be sent elsewhere. */
  private assertGraphUrl(url: string) {
    const expected = new URL(this.base);
    const u = new URL(url);
    if (u.origin !== expected.origin || !u.pathname.startsWith(expected.pathname)) {
      throw new Error("Refusing to follow a pagination link outside Microsoft Graph");
    }
  }

  private async request<T>(url: string, signal?: AbortSignal, extra: Record<string, string> = {}, allow404 = false) {
    return requestJson<T>(
      url,
      {
        headers: {
          authorization: `Bearer ${await this.o.getToken()}`,
          // Stable ids survive moving a message between folders, so "already scanned" stays accurate.
          prefer: 'IdType="ImmutableId"',
          ...extra,
        },
      },
      { fetchImpl: this.o.fetchImpl, sleep: this.o.sleep, signal, allow404 },
    );
  }

  async total(since?: Date): Promise<number | null> {
    try {
      const filter = since ? `?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` : "";
      const res = await (this.o.fetchImpl ?? fetch)(`${this.base}/me/messages/$count${filter}`, {
        headers: { authorization: `Bearer ${await this.o.getToken()}`, consistencylevel: "eventual" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const n = Number((await res.text()).trim());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private loadSkippedFolders(signal?: AbortSignal): Promise<Set<string>> {
    this.skippedFolderIds ??= (async () => {
      const ids = new Set<string>();
      for (const name of SKIPPED_FOLDERS) {
        const f = await this.request<{ id?: string }>(`${this.base}/me/mailFolders/${name}?$select=id`, signal, {}, true);
        if (f?.id) ids.add(f.id);
      }
      return ids;
    })();
    return this.skippedFolderIds;
  }

  async *pages({ skip, signal, since, includeJunk }: PagesOptions): AsyncIterable<MessageHeader[]> {
    const skipFolders = includeJunk ? new Set<string>() : await this.loadSkippedFolders(signal);
    const select = "id,receivedDateTime,from,subject,parentFolderId,internetMessageHeaders";
    // Graph requires the filtered property to lead the $orderby, which it already does.
    const filter = since ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` : "";
    let url: string | undefined =
      `${this.base}/me/messages?$select=${select}${filter}&$orderby=receivedDateTime desc&$top=${PAGE_SIZE}`;

    while (url) {
      signal?.throwIfAborted();
      this.assertGraphUrl(url);
      const page: GraphPage = (await this.request<GraphPage>(url, signal))!;

      const headers: MessageHeader[] = [];
      for (const m of page.value ?? []) {
        if (skip(m.id) || (m.parentFolderId && skipFolders.has(m.parentFolderId))) continue;
        headers.push(toHeader(m));
      }
      if (headers.length) yield headers;
      url = page["@odata.nextLink"];
    }
  }

  async close() {}
}

function toHeader(m: GraphMessage): MessageHeader {
  const h: Record<string, string> = {};
  for (const { name, value } of m.internetMessageHeaders ?? []) h[name.toLowerCase()] ??= value;
  const t = m.receivedDateTime ? Date.parse(m.receivedDateTime) : NaN;
  return {
    id: m.id,
    date: new Date(Number.isFinite(t) ? t : 0),
    fromEmail: (m.from?.emailAddress?.address ?? "").toLowerCase(),
    fromName: m.from?.emailAddress?.name?.trim() || null,
    subject: m.subject ?? "",
    listUnsubscribe: h["list-unsubscribe"],
    listUnsubscribePost: h["list-unsubscribe-post"],
    listId: h["list-id"],
    precedence: h.precedence,
  };
}
