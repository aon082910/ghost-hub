import { describe, expect, it, vi } from "vitest";
import { coverageOf } from "./coverage";
import { DEPTHS, isDepth, sinceFor } from "./depth";
import { GmailSource } from "./gmail";
import { GraphSource } from "./graph";
import { ImapSource, type ImapScanClient } from "./imap-source";

const NOW = new Date("2026-06-15T12:00:00Z");
const SINCE = new Date("2024-03-01T00:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const drain = async (it: AsyncIterable<unknown>) => {
  for await (const _ of it) void _;
};

describe("depth choices", () => {
  it("turns each choice into the earliest date to read", () => {
    expect(sinceFor("all", NOW)).toBeUndefined();
    expect(sinceFor("5y", NOW)?.toISOString()).toBe("2021-06-15T12:00:00.000Z");
    expect(sinceFor("2y", NOW)?.toISOString()).toBe("2024-06-15T12:00:00.000Z");
    expect(sinceFor("1y", NOW)?.toISOString()).toBe("2025-06-15T12:00:00.000Z");
    expect(sinceFor("90d", NOW)?.toISOString()).toBe("2026-03-17T12:00:00.000Z");
  });

  it("doesn't change the date it was given", () => {
    const now = new Date(NOW);
    sinceFor("5y", now);
    expect(now.toISOString()).toBe(NOW.toISOString());
  });

  it("only accepts the listed choices, so a form can't smuggle in anything else", () => {
    for (const d of DEPTHS) expect(isDepth(d.id)).toBe(true);
    for (const bad of ["", "ALL", "10y", "all ", "__proto__", null, undefined, 5, {}, ["all"]]) expect(isDepth(bad), String(bad)).toBe(false);
  });

  it("offers 'all mail' first, as the default", () => {
    expect(DEPTHS[0].id).toBe("all");
  });
});

describe("Gmail", () => {
  function gmail() {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return String(input).includes("/profile") ? json({ messagesTotal: 500 }) : json({ messages: [] });
    });
    return { urls, src: new GmailSource({ getToken: async () => "t", fetchImpl, base: "https://gmail.test/v1" }) };
  }

  it("adds an `after:` limit in epoch seconds, and none for a full scan", async () => {
    const limited = gmail();
    await drain(limited.src.pages({ skip: () => false, since: SINCE }));
    const q = new URL(limited.urls[0]).searchParams.get("q")!;
    expect(q).toContain(`after:${SINCE.getTime() / 1000}`);
    expect(q).toContain("-in:sent"); // the usual exclusions still apply

    const full = gmail();
    await drain(full.src.pages({ skip: () => false }));
    expect(new URL(full.urls[0]).searchParams.get("q")).not.toContain("after:");
  });

  it("has no honest total for a limited scan, so it doesn't guess (and makes no request)", async () => {
    const g = gmail();
    expect(await g.src.total(SINCE)).toBeNull();
    expect(g.urls).toEqual([]);
    expect(await g.src.total()).toBe(500);
  });
});

describe("Microsoft Graph", () => {
  function graph() {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/$count")) return new Response("42", { status: 200 });
      if (url.includes("/mailFolders/")) return json({}, 404);
      return json({ value: [] });
    });
    return { urls, src: new GraphSource({ getToken: async () => "t", fetchImpl, base: "https://graph.test/v1.0" }) };
  }

  it("filters on receivedDateTime, keeping it as the leading order-by property", async () => {
    const g = graph();
    await drain(g.src.pages({ skip: () => false, since: SINCE }));
    const list = decodeURIComponent(g.urls.find((u) => u.includes("/me/messages?"))!);
    expect(list).toContain("$filter=receivedDateTime ge 2024-03-01T00:00:00.000Z");
    expect(list).toContain("$orderby=receivedDateTime desc");
    expect(list.indexOf("$filter")).toBeLessThan(list.indexOf("$orderby"));
  });

  it("doesn't filter a full scan", async () => {
    const g = graph();
    await drain(g.src.pages({ skip: () => false }));
    expect(decodeURIComponent(g.urls.find((u) => u.includes("/me/messages?"))!)).not.toContain("$filter");
  });

  it("counts only the window for the progress estimate", async () => {
    const g = graph();
    expect(await g.src.total(SINCE)).toBe(42);
    expect(decodeURIComponent(g.urls.at(-1)!)).toContain("/$count?$filter=receivedDateTime ge 2024-03-01T00:00:00.000Z");
    await g.src.total();
    expect(g.urls.at(-1)).toMatch(/\/\$count$/);
  });
});

describe("IMAP", () => {
  function imap(uids: number[]) {
    const search = vi.fn<ImapScanClient["search"]>(async () => [...uids]);
    const status = vi.fn(async () => ({ messages: 999 }));
    const client: ImapScanClient = {
      connect: async () => {},
      list: async () => [{ path: "INBOX" }],
      status,
      getMailboxLock: async () => ({ release: () => {} }),
      mailbox: { uidValidity: 1 },
      search,
      async *fetch() {},
      logout: async () => {},
      close: () => {},
    };
    return { src: new ImapSource(client), search, status };
  }

  it("searches SINCE the date for a limited scan, and ALL otherwise", async () => {
    const limited = imap([1, 2]);
    await drain(limited.src.pages({ skip: () => false, since: SINCE }));
    expect(limited.search).toHaveBeenCalledWith({ since: SINCE }, { uid: true });

    const full = imap([1, 2]);
    await drain(full.src.pages({ skip: () => false }));
    expect(full.search).toHaveBeenCalledWith({ all: true }, { uid: true });
  });

  it("counts the window by searching, and the whole folder from its status otherwise", async () => {
    const limited = imap([1, 2, 3]);
    expect(await limited.src.total(SINCE)).toBe(3);
    expect(limited.status).not.toHaveBeenCalled();

    const full = imap([1, 2, 3]);
    expect(await full.src.total()).toBe(999);
    expect(full.search).not.toHaveBeenCalled();
  });
});

describe("coverage", () => {
  const done = (since: Date | null, processed = 10) => ({ status: "done", since, messagesProcessed: processed });

  it("is complete once a full scan has finished, whatever else happened", () => {
    expect(coverageOf([done(null)])).toEqual({ kind: "complete" });
    expect(coverageOf([done(SINCE), done(null), { status: "failed", since: null, messagesProcessed: 5 }])).toEqual({ kind: "complete" });
  });

  it("is limited when only limited scans finished, reporting the widest reach", () => {
    expect(coverageOf([done(SINCE)])).toEqual({ kind: "limited", since: SINCE });
    const wider = new Date("2020-01-01T00:00:00Z");
    expect(coverageOf([done(SINCE), done(wider), done(new Date("2026-01-01"))])).toEqual({ kind: "limited", since: wider });
  });

  it("is unfinished when a full scan read something but never completed", () => {
    expect(coverageOf([{ status: "cancelled", since: null, messagesProcessed: 40 }])).toEqual({ kind: "unfinished" });
    expect(coverageOf([{ status: "failed", since: null, messagesProcessed: 1 }])).toEqual({ kind: "unfinished" });
    expect(coverageOf([{ status: "running", since: null, messagesProcessed: 3 }])).toEqual({ kind: "unfinished" });
  });

  it("is limited, not unfinished, if a limited scan finished even though a full one was cancelled", () => {
    expect(coverageOf([done(SINCE), { status: "cancelled", since: null, messagesProcessed: 40 }])).toEqual({ kind: "limited", since: SINCE });
  });

  it("is none for a mailbox that was never scanned or whose scans read nothing", () => {
    expect(coverageOf([])).toEqual({ kind: "none" });
    expect(coverageOf([{ status: "failed", since: null, messagesProcessed: 0 }])).toEqual({ kind: "none" });
  });
});
