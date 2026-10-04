import { describe, expect, it, vi } from "vitest";
import { GmailSource } from "./gmail";
import { GraphSource } from "./graph";
import { ScanHttpError, chunk, mapLimit, requestJson, retryAfterMs } from "./http";
import { ImapSource, isJunkFolder, isSkippedFolder, type FetchedMessage, type ImapScanClient } from "./imap-source";
import type { MessageHeader } from "./types";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function collect(it: AsyncIterable<MessageHeader[]>) {
  const pages: MessageHeader[][] = [];
  for await (const p of it) pages.push(p);
  return pages;
}

const noSkip = { skip: () => false };
const noSleep = () => Promise.resolve();

describe("http helpers", () => {
  it("retries 429 and 5xx with Retry-After, then succeeds", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: 1 }));
    expect(await requestJson("https://x", {}, { fetchImpl, sleep })).toEqual({ ok: 1 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 1000]);
  });

  it("gives up after the retry budget and doesn't retry client errors", async () => {
    const always503 = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 503));
    await expect(requestJson("https://x", {}, { fetchImpl: always503, sleep: noSleep, retries: 2 })).rejects.toMatchObject({ status: 503 });
    expect(always503).toHaveBeenCalledTimes(3);
    const bad = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 403));
    await expect(requestJson("https://x", {}, { fetchImpl: bad, sleep: noSleep })).rejects.toBeInstanceOf(ScanHttpError);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("returns null for an allowed 404", async () => {
    const fetchImpl = (async () => json({}, 404)) as typeof fetch;
    expect(await requestJson("https://x", {}, { fetchImpl, allow404: true })).toBeNull();
    await expect(requestJson("https://x", {}, { fetchImpl })).rejects.toMatchObject({ status: 404 });
  });

  it("caps Retry-After and ignores nonsense values", () => {
    expect(retryAfterMs("5", 1)).toBe(5000);
    expect(retryAfterMs("99999", 1)).toBe(30_000);
    expect(retryAfterMs("soon", 777)).toBe(777);
    expect(retryAfterMs(null, 777)).toBe(777);
    expect(retryAfterMs("-3", 777)).toBe(777);
  });

  it("mapLimit preserves order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 - (n % 3)));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("GmailSource", () => {
  const message = (id: string, headers: Record<string, string>, internalDate = "1700000000000", labelIds?: string[]) => ({
    id,
    internalDate,
    ...(labelIds ? { labelIds } : {}),
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });

  function fakeGmail(messages: Record<string, ReturnType<typeof message> | null>, pages: string[][]) {
    const urls: string[] = [];
    const auth: (string | null)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      urls.push(url);
      auth.push(new Headers(init?.headers).get("authorization"));
      const u = new URL(url);
      if (u.pathname.endsWith("/users/me/profile")) return json({ messagesTotal: 42 });
      if (u.pathname.endsWith("/users/me/messages")) {
        const token = u.searchParams.get("pageToken");
        const i = token ? Number(token) : 0;
        return json({ messages: pages[i].map((id) => ({ id })), nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined });
      }
      const id = decodeURIComponent(u.pathname.split("/").pop()!);
      const m = messages[id];
      return m ? json(m) : json({}, 404);
    });
    return { fetchImpl, urls, auth };
  }

  const make = (f: ReturnType<typeof fakeGmail>) =>
    new GmailSource({ getToken: async () => "tok", fetchImpl: f.fetchImpl, base: "https://gmail.test/v1", sleep: noSleep });

  it("pages through the list, fetches header metadata only, and parses headers", async () => {
    const f = fakeGmail(
      {
        a: message("a", { From: '"PayPal" <service@paypal.com>', Subject: "Receipt", "List-Unsubscribe": "<https://p/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "List-Id": "<l>", Precedence: "bulk" }),
        b: message("b", { from: "x@y.com", subject: "Hi" }),
        c: message("c", { From: "z@z.com" }),
      },
      [["a", "b"], ["c"]],
    );
    const pages = (await collect(make(f).pages(noSkip))).flat();
    expect(pages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(pages[0]).toMatchObject({
      fromEmail: "service@paypal.com",
      fromName: "PayPal",
      subject: "Receipt",
      listUnsubscribe: "<https://p/u>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      listId: "<l>",
      precedence: "bulk",
    });
    expect(pages[0].date.getTime()).toBe(1700000000000);
    expect(pages[1]).toMatchObject({ fromEmail: "x@y.com", subject: "Hi" }); // header names are case-insensitive
    expect(pages[2].subject).toBe("");

    const listUrl = new URL(f.urls.find((u) => u.includes("/messages?"))!);
    expect(listUrl.searchParams.get("q")).toBe("-in:sent -in:drafts -in:chats");
    const metaUrl = new URL(f.urls.find((u) => /messages\/a\?/.test(u))!);
    expect(metaUrl.searchParams.get("format")).toBe("metadata"); // never 'full' or 'raw': no bodies
    expect(metaUrl.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Precedence"]);
    expect(new Set(f.auth)).toEqual(new Set(["Bearer tok"]));
  });

  it("with includeJunk it asks for spam and trash and stops excluding sent and drafts", async () => {
    const f = fakeGmail({ a: message("a", { From: "a@a.com" }) }, [["a"]]);
    await collect(make(f).pages({ ...noSkip, includeJunk: true, since: new Date("2024-01-01T00:00:00Z") }));
    const listUrl = new URL(f.urls.find((u) => u.includes("/messages?"))!);
    expect(listUrl.searchParams.get("includeSpamTrash")).toBe("true");
    expect(listUrl.searchParams.get("q")).toBe(`-in:chats after:${Math.floor(Date.UTC(2024, 0, 1) / 1000)}`);

    const plain = fakeGmail({ a: message("a", { From: "a@a.com" }) }, [["a"]]);
    await collect(make(plain).pages(noSkip));
    expect(new URL(plain.urls.find((u) => u.includes("/messages?"))!).searchParams.has("includeSpamTrash")).toBe(false);
  });

  it("marks mail labelled SPAM as junk and asks Gmail for the label", async () => {
    const f = fakeGmail(
      { a: message("a", { From: "a@a.com" }, undefined, ["INBOX"]), b: message("b", { From: "b@b.com" }, undefined, ["SPAM", "UNREAD"]), c: message("c", { From: "c@c.com" }) },
      [["a", "b", "c"]],
    );
    const msgs = (await collect(make(f).pages({ ...noSkip, includeJunk: true }))).flat();
    expect(msgs.map((m) => m.junk)).toEqual([false, true, false]);
    const metaUrl = new URL(f.urls.find((u) => /messages\/a\?/.test(u))!);
    expect(metaUrl.searchParams.get("fields")).toContain("labelIds");
  });

  it("doesn't fetch skipped messages and tolerates ones deleted mid-scan", async () => {
    const f = fakeGmail({ a: message("a", { From: "a@a.com" }), b: null, c: message("c", { From: "c@c.com" }) }, [["a", "b", "c"]]);
    const pages = (await collect(make(f).pages({ skip: (id) => id === "a" }))).flat();
    expect(pages.map((m) => m.id)).toEqual(["c"]);
    expect(f.urls.some((u) => /messages\/a\?/.test(u))).toBe(false);
  });

  it("yields in chunks of 100 so progress updates", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    const messages = Object.fromEntries(ids.map((id) => [id, message(id, { From: "a@a.com" })]));
    const pages = await collect(make(fakeGmail(messages, [ids])).pages(noSkip));
    expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  it("estimates the total from the profile and stops when aborted", async () => {
    const f = fakeGmail({ a: message("a", { From: "a@a.com" }) }, [["a"]]);
    expect(await make(f).total()).toBe(42);
    const c = new AbortController();
    c.abort();
    await expect(collect(make(f).pages({ skip: () => false, signal: c.signal }))).rejects.toThrow();
  });
});

describe("GraphSource", () => {
  const BASE = "https://graph.test/v1.0";
  const gm = (id: string, folder: string, extra: Record<string, unknown> = {}) => ({
    id,
    parentFolderId: folder,
    receivedDateTime: "2024-05-01T10:00:00Z",
    subject: "Hello",
    from: { emailAddress: { address: "News@Shop.com", name: " Shop " } },
    internetMessageHeaders: [
      { name: "List-Unsubscribe", value: "<https://shop.com/u>" },
      { name: "list-unsubscribe-post", value: "List-Unsubscribe=One-Click" },
    ],
    ...extra,
  });

  function fakeGraph(pages: { value: unknown[]; next?: string }[]) {
    const calls: { url: string; headers: Headers }[] = [];
    const folders: Record<string, string | null> = { junkemail: "F-junk", deleteditems: "F-del", sentitems: "F-sent", drafts: null };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      const u = new URL(url);
      if (u.pathname.endsWith("/$count")) return new Response("1234", { status: 200 });
      const f = u.pathname.match(/mailFolders\/(\w+)$/);
      if (f) return folders[f[1]] ? json({ id: folders[f[1]] }) : json({}, 404);
      const page = Number(u.searchParams.get("page") ?? 0);
      return json({ value: pages[page].value, "@odata.nextLink": pages[page].next });
    });
    return { fetchImpl, calls };
  }
  const make = (f: ReturnType<typeof fakeGraph>) =>
    new GraphSource({ getToken: async () => "tok", fetchImpl: f.fetchImpl, base: BASE, sleep: noSleep });

  it("follows nextLink, parses headers and drops Junk, Deleted and Sent mail", async () => {
    const f = fakeGraph([
      { value: [gm("1", "inbox"), gm("2", "F-junk"), gm("3", "F-sent")], next: `${BASE}/me/messages?page=1` },
      { value: [gm("4", "F-del"), gm("5", "archive", { from: undefined, subject: null })] },
    ]);
    const msgs = (await collect(make(f).pages(noSkip))).flat();
    expect(msgs.map((m) => m.id)).toEqual(["1", "5"]);
    expect(msgs[0]).toMatchObject({
      fromEmail: "news@shop.com",
      fromName: "Shop",
      listUnsubscribe: "<https://shop.com/u>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    expect(msgs[0].date.toISOString()).toBe("2024-05-01T10:00:00.000Z");
    expect(msgs[1]).toMatchObject({ fromEmail: "", subject: "" }); // missing from/subject don't crash

    const first = f.calls.find((c) => c.url.includes("/me/messages?"))!;
    expect(first.headers.get("prefer")).toBe('IdType="ImmutableId"');
    expect(first.headers.get("authorization")).toBe("Bearer tok");
    expect(decodeURIComponent(first.url)).toContain("$select=id,receivedDateTime,from,subject,parentFolderId,internetMessageHeaders");
    expect(decodeURIComponent(first.url)).not.toMatch(/body/i); // no bodies
  });

  it("with includeJunk it keeps Junk, Deleted and Sent mail, and marks only the Junk folder's mail as junk", async () => {
    const f = fakeGraph([{ value: [gm("1", "inbox"), gm("2", "F-junk"), gm("3", "F-sent"), gm("4", "F-del")] }]);
    const msgs = (await collect(make(f).pages({ ...noSkip, includeJunk: true }))).flat();
    expect(msgs.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
    expect(msgs.map((m) => m.junk)).toEqual([false, true, false, false]); // Trash and Sent aren't spam
  });

  it("without includeJunk nothing from Junk is returned, and what is returned isn't marked junk", async () => {
    const f = fakeGraph([{ value: [gm("1", "inbox"), gm("2", "F-junk")] }]);
    const msgs = (await collect(make(f).pages(noSkip))).flat();
    expect(msgs.map((m) => [m.id, m.junk])).toEqual([["1", false]]);
  });

  it("skips known ids", async () => {
    const f = fakeGraph([{ value: [gm("1", "inbox"), gm("2", "inbox")] }]);
    const msgs = (await collect(make(f).pages({ skip: (id) => id === "1" }))).flat();
    expect(msgs.map((m) => m.id)).toEqual(["2"]);
  });

  it("refuses a nextLink that leaves Graph and never sends the token there", async () => {
    const f = fakeGraph([{ value: [gm("1", "inbox")], next: "https://evil.example.com/steal?page=1" }]);
    await expect(collect(make(f).pages(noSkip))).rejects.toThrow(/outside Microsoft Graph/);
    expect(f.calls.some((c) => c.url.includes("evil.example.com"))).toBe(false);
  });

  it("refuses look-alike hosts and other paths on the same host", async () => {
    for (const next of ["https://graph.test.evil.com/v1.0/x", "http://graph.test/v1.0/x", "https://graph.test/other/x"]) {
      const f = fakeGraph([{ value: [gm("1", "inbox")], next }]);
      await expect(collect(make(f).pages(noSkip)), next).rejects.toThrow(/outside Microsoft Graph/);
    }
  });

  it("reads the total from $count and returns null on failure", async () => {
    expect(await make(fakeGraph([])).total()).toBe(1234);
    const failing = new GraphSource({ getToken: async () => "t", base: BASE, fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch });
    expect(await failing.total()).toBeNull();
  });
});

describe("ImapSource", () => {
  type Folder = { path: string; specialUse?: string; flags?: Set<string> };

  function fakeClient(folders: Folder[], uidsByFolder: Record<string, number[]>, extra: Partial<ImapScanClient> = {}) {
    const state = { released: 0, fetched: [] as string[], locked: [] as string[], connected: 0, loggedOut: 0 };
    let current = "";
    const client: ImapScanClient = {
      connect: async () => void state.connected++,
      list: async () => folders,
      status: async (path) => ({ messages: uidsByFolder[path]?.length ?? 0 }),
      getMailboxLock: async (path) => {
        current = path;
        state.locked.push(path);
        return { release: () => void state.released++ };
      },
      get mailbox() {
        return { uidValidity: BigInt(77) };
      },
      search: async () => [...(uidsByFolder[current] ?? [])],
      async *fetch(range) {
        state.fetched.push(`${current}:${range}`);
        for (const uid of range.split(",").map(Number)) {
          yield {
            uid,
            envelope: { date: new Date("2024-02-02T00:00:00Z"), subject: `S${uid}`, from: [{ name: " Acme ", address: "Info@Acme.com" }] },
            headers: Buffer.from("List-Unsubscribe: <https://acme.com/u>\r\nList-Id: <acme>\r\n\r\n"),
          } satisfies FetchedMessage;
        }
      },
      logout: async () => void state.loggedOut++,
      close: () => {},
      ...extra,
    };
    return { client, state };
  }

  const FOLDERS: Folder[] = [
    { path: "INBOX" },
    { path: "Archive" },
    { path: "Junk", specialUse: "\\Junk" },
    { path: "Trash", specialUse: "\\Trash" },
    { path: "Sent Items", specialUse: "\\Sent" },
    { path: "Draft", specialUse: "\\Drafts" },
    { path: "Bulk" }, // Yahoo's spam folder has no flag
    { path: "[Gmail]", flags: new Set(["\\Noselect"]) },
  ];

  it("skips Junk/Trash/Sent/Drafts (by flag or name) and non-selectable folders", () => {
    expect(FOLDERS.filter((f) => !isSkippedFolder(f)).map((f) => f.path)).toEqual(["INBOX", "Archive"]);
    expect(isSkippedFolder({ path: "Deleted Messages" })).toBe(true);
    expect(isSkippedFolder({ path: "INBOX.Spam" })).toBe(true);
    expect(isSkippedFolder({ path: "Work/Sent" })).toBe(true);
    expect(isSkippedFolder({ path: "Receipts" })).toBe(false);
    expect(isSkippedFolder({ path: "Sentinel" })).toBe(false); // a name merely starting with "sent"
  });

  it("with includeJunk reads Spam, Trash, Sent and Drafts too, but never a folder that can't be opened", async () => {
    expect(FOLDERS.filter((f) => !isSkippedFolder(f, true)).map((f) => f.path)).toEqual(["INBOX", "Archive", "Junk", "Trash", "Sent Items", "Draft", "Bulk"]);
    expect(isSkippedFolder({ path: "[Gmail]", flags: new Set(["\\Noselect"]) }, true)).toBe(true);
    expect(isSkippedFolder({ path: "Gone", flags: new Set(["\\NonExistent"]) }, true)).toBe(true);
  });

  it("includeJunk applies to the total and the pages, and the two folder lists don't leak into each other", async () => {
    const uids = { INBOX: [1, 2], Archive: [10], Junk: [1, 2, 3], Trash: [5], "Sent Items": [7], Draft: [], Bulk: [9] };
    const { client, state } = fakeClient(FOLDERS, uids);
    const src = new ImapSource(client);
    expect(await src.total(undefined, false)).toBe(3);
    const full = (await collect(src.pages({ ...noSkip, includeJunk: true }))).flat();
    expect(full.length).toBe(2 + 1 + 3 + 1 + 1 + 0 + 1);
    const plain = (await collect(src.pages(noSkip))).flat();
    expect(plain.length).toBe(3);
    expect(state.locked.slice(0, 7)).toEqual(["INBOX", "Archive", "Junk", "Trash", "Sent Items", "Draft", "Bulk"]);
  });

  it("recognises spam folders by flag or name, but not Trash or Sent", () => {
    expect(isJunkFolder({ path: "Junk", specialUse: "\\Junk" })).toBe(true);
    expect(isJunkFolder({ path: "Bulk" })).toBe(true);
    expect(isJunkFolder({ path: "INBOX.Spam" })).toBe(true);
    expect(isJunkFolder({ path: "Bulk Mail" })).toBe(true);
    for (const p of ["INBOX", "Trash", "Sent Items", "Draft", "Archive", "Junkyard"]) expect(isJunkFolder({ path: p }), p).toBe(false);
    expect(isJunkFolder({ path: "Trash", specialUse: "\\Trash" })).toBe(false);
  });

  it("marks only mail read from a spam folder as junk", async () => {
    const { client } = fakeClient(FOLDERS, { INBOX: [1], Trash: [2], "Sent Items": [3], Bulk: [4], Junk: [5] });
    const msgs = (await collect(new ImapSource(client).pages({ ...noSkip, includeJunk: true }))).flat();
    const byFolder = Object.fromEntries(msgs.map((m) => [m.id.split(":")[0], m.junk]));
    expect(byFolder).toEqual({ INBOX: false, Trash: false, "Sent Items": false, Bulk: true, Junk: true });
  });

  it("scans the remaining folders newest-first, with ids that include the folder and uidValidity", async () => {
    const { client, state } = fakeClient(FOLDERS, { INBOX: [1, 2, 3], Archive: [10, 11] });
    const msgs = (await collect(new ImapSource(client).pages(noSkip))).flat();
    expect(msgs.map((m) => m.id)).toEqual(["INBOX:77:3", "INBOX:77:2", "INBOX:77:1", "Archive:77:11", "Archive:77:10"]);
    expect(state.locked).toEqual(["INBOX", "Archive"]);
    expect(state.released).toBe(2);
    expect(msgs[0]).toMatchObject({
      fromEmail: "info@acme.com",
      fromName: "Acme",
      subject: "S3",
      listUnsubscribe: "<https://acme.com/u>",
      listId: "<acme>",
    });
    expect(msgs[0].date.toISOString()).toBe("2024-02-02T00:00:00.000Z");
  });

  it("doesn't fetch skipped uids and fetches in chunks of 100", async () => {
    const uids = Array.from({ length: 230 }, (_, i) => i + 1);
    const { client, state } = fakeClient([{ path: "INBOX" }], { INBOX: uids });
    const pages = await collect(new ImapSource(client).pages({ skip: (id) => id.endsWith(":230") }));
    expect(pages.map((p) => p.length)).toEqual([99, 100, 30]);
    expect(state.fetched).toHaveLength(3);
    expect(state.fetched[0]).not.toContain("230");
  });

  it("releases the folder lock even when a fetch fails", async () => {
    const { client, state } = fakeClient([{ path: "INBOX" }], { INBOX: [1] }, {
      async *fetch() {
        throw new Error("connection lost");
      },
    });
    await expect(collect(new ImapSource(client).pages(noSkip))).rejects.toThrow("connection lost");
    expect(state.released).toBe(1);
  });

  it("sums folder sizes for the total, connects once and logs out on close", async () => {
    const { client, state } = fakeClient(FOLDERS, { INBOX: [1, 2, 3], Archive: [1, 2], Junk: [1, 2, 3, 4, 5] });
    const src = new ImapSource(client);
    expect(await src.total()).toBe(5); // Junk excluded
    await collect(src.pages(noSkip));
    await src.close();
    expect(state.connected).toBe(1);
    expect(state.loggedOut).toBe(1);
  });

  it("close is a no-op if never connected, and falls back to close() if logout fails", async () => {
    const a = fakeClient([], {});
    await new ImapSource(a.client).close();
    expect(a.state.loggedOut).toBe(0);

    const closeSpy = vi.fn();
    const b = fakeClient([{ path: "INBOX" }], { INBOX: [] }, { logout: async () => Promise.reject(new Error("x")), close: closeSpy });
    const src = new ImapSource(b.client);
    await src.total();
    await src.close();
    expect(closeSpy).toHaveBeenCalled();
  });
});
