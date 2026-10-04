import { describe, expect, it, vi } from "vitest";
import { describeScanError } from "./engine";
import { ScanHttpError, readApiError, requestJson } from "./http";

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

// The shape Google really returns when the Gmail API hasn't been switched on for the project.
const SERVICE_DISABLED = {
  error: {
    code: 403,
    message: "Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123",
    errors: [{ message: "x", domain: "usageLimits", reason: "accessNotConfigured" }],
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        metadata: { service: "gmail.googleapis.com", activationUrl: "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123" },
      },
    ],
  },
};

describe("readApiError", () => {
  it("pulls the reason, a trimmed message and the console link out of a Google error", async () => {
    const info = await readApiError(json(SERVICE_DISABLED, 403));
    expect(info.reason).toBe("SERVICE_DISABLED");
    expect(info.message).toMatch(/^Gmail API has not been used/);
    expect(info.activationUrl).toBe("https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123");
  });

  it("understands Microsoft Graph errors", async () => {
    const info = await readApiError(json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403));
    expect(info).toMatchObject({ reason: "ErrorAccessDenied", message: "Access is denied." });
  });

  it("only passes on links to Google's own consoles", async () => {
    const evil = structuredClone(SERVICE_DISABLED);
    evil.error.details[0].metadata.activationUrl = "https://evil.test/console.developers.google.com/";
    expect((await readApiError(json(evil, 403))).activationUrl).toBeNull();
    evil.error.details[0].metadata.activationUrl = "http://console.developers.google.com/apis";
    expect((await readApiError(json(evil, 403))).activationUrl).toBeNull();
  });

  it("never throws and never trusts odd values", async () => {
    for (const res of [new Response("<html>nope</html>", { status: 403 }), new Response("", { status: 403 }), json([1, 2], 403), json({ error: "x y z" }, 403), json({ error: { details: "bad", errors: 5 } }, 403)]) {
      const info = await readApiError(res);
      expect(info.activationUrl).toBeNull();
      expect(info.reason === null || /^[A-Za-z0-9_.-]+$/.test(info.reason)).toBe(true);
    }
    expect((await readApiError(json({ error: { message: "x".repeat(5000) } }, 403))).message).toHaveLength(200);
  });
});

describe("requestJson with API errors", () => {
  it("attaches what the API said to the error", async () => {
    const f = vi.fn<typeof fetch>(async () => json(SERVICE_DISABLED, 403));
    const err = (await requestJson("https://x", {}, { fetchImpl: f, sleep: noSleep }).catch((e) => e)) as ScanHttpError;
    expect(err).toBeInstanceOf(ScanHttpError);
    expect(err.status).toBe(403);
    expect(err.info.reason).toBe("SERVICE_DISABLED");
    expect(f).toHaveBeenCalledTimes(1); // a real refusal is not retried
  });

  it("retries Gmail's rate-limit 403, which isn't a 429", async () => {
    let n = 0;
    const f = vi.fn<typeof fetch>(async () => (n++ < 2 ? json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403) : json({ ok: true }, 200)));
    expect(await requestJson("https://x", {}, { fetchImpl: f, sleep: noSleep })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("describeScanError for refused requests", () => {
  const err = (status: number, body: unknown) => requestJson("https://x", {}, { fetchImpl: async () => json(body, status), sleep: noSleep }).catch((e) => e);

  it("tells you to switch the Gmail API on, with Google's link", async () => {
    const text = describeScanError(await err(403, SERVICE_DISABLED));
    expect(text).toMatch(/Gmail API is switched off/);
    expect(text).toContain("https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123");
  });

  it("still says how to switch it on when Google gave no link", async () => {
    const text = describeScanError(await err(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }));
    expect(text).toMatch(/Library, Gmail API, Enable/);
  });

  it("tells you to reconnect when the permission wasn't granted", async () => {
    for (const reason of ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]) {
      expect(describeScanError(await err(403, { error: { errors: [{ reason }] } }))).toMatch(/connect again/);
    }
    expect(describeScanError(await err(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } }))).toMatch(/connect again/);
  });

  it("asks for a reconnect on 401, and otherwise reports the status and reason", async () => {
    expect(describeScanError(await err(401, { error: { message: "Invalid Credentials" } }))).toMatch(/connect it again/);
    expect(describeScanError(await err(403, { error: { errors: [{ reason: "forbidden" }], message: "Nope" } }))).toBe("The mail service refused the request (HTTP 403, forbidden: Nope).");
    expect(describeScanError(await err(400, "not json"))).toBe("The mail service refused the request (HTTP 400).");
  });
});

describe("backing off when Gmail's quota is hit", () => {
  const quota = () => json({ error: { code: 403, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }], details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } }, 403);

  it("waits longer each time, up to a minute, and keeps trying for several minutes before giving up", async () => {
    const waits: number[] = [];
    const f = vi.fn<typeof fetch>(async () => quota());
    const err = (await requestJson("https://x", {}, { fetchImpl: f, sleep: async (ms) => void waits.push(ms) }).catch((e) => e)) as ScanHttpError;
    expect(err).toBeInstanceOf(ScanHttpError);
    expect(err.info.reason).toBe("RATE_LIMIT_EXCEEDED");
    expect(waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000]); // a per-minute quota only clears when the minute rolls over
    expect(f).toHaveBeenCalledTimes(7);
  });

  it("recovers as soon as the quota clears, and honours Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    const f = vi.fn<typeof fetch>(async () => (n++ < 2 ? new Response(JSON.stringify({ error: { details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } }), { status: 403, headers: { "retry-after": "12" } }) : json({ ok: 1 }, 200)));
    expect(await requestJson("https://x", {}, { fetchImpl: f, sleep: async (ms) => void waits.push(ms) })).toEqual({ ok: 1 });
    expect(waits).toEqual([12000, 12000]);
  });

  it("keeps the short, fixed retry budget for ordinary server errors", async () => {
    const waits: number[] = [];
    const f = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    await requestJson("https://x", {}, { fetchImpl: f, sleep: async (ms) => void waits.push(ms) }).catch(() => {});
    expect(waits).toEqual([500, 1000, 2000, 4000]);
  });
});

describe("Gmail request pacing", () => {
  it("spaces requests out so a fast connection stays under the quota", async () => {
    const { GmailSource } = await import("./gmail");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); // time stands still, so the waits are exact
    try {
      const waits: number[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/users/me/messages")) return json({ messages: ["a", "b", "c", "d"].map((id) => ({ id })) }, 200);
        return json({ id: decodeURIComponent(u.pathname.split("/").pop()!), internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "x@y.com" }] } }, 200);
      });
      const src = new GmailSource({ getToken: async () => "t", fetchImpl, base: "https://gmail.test/v1", sleep: async (ms) => void waits.push(ms), requestsPerSecond: 10, concurrency: 4 });
      for await (const page of src.pages({ skip: () => false })) void page;
      // 1 list + 4 message lookups = 5 requests, one every 100 ms; the first goes straight out.
      expect(waits).toEqual([100, 200, 300, 400]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be switched off", async () => {
    const { GmailSource } = await import("./gmail");
    const waits: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ messages: [] }, 200));
    const src = new GmailSource({ getToken: async () => "t", fetchImpl, base: "https://gmail.test/v1", sleep: async (ms) => void waits.push(ms), requestsPerSecond: Infinity });
    for await (const page of src.pages({ skip: () => false })) void page;
    expect(waits).toEqual([]);
  });

  it("defaults to 40 requests a second, which is 12,000 quota units a minute against Gmail's 15,000", async () => {
    const { GmailSource } = await import("./gmail");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const waits: number[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async () => json({ messages: [] }, 200));
      const src = new GmailSource({ getToken: async () => "t", fetchImpl, base: "https://gmail.test/v1", sleep: async (ms) => void waits.push(ms) });
      await src.total(); // profile request, then two more
      await src.total();
      await src.total();
      expect(waits).toEqual([25, 50]);
    } finally {
      vi.useRealTimers();
    }
  });
});
