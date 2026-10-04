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
