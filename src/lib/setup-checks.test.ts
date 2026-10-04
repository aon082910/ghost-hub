import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "./env";
import { setupNotes } from "./setup-checks";

const base = { APP_URL: "http://localhost:3000", ADMIN_PASSWORD: "a-long-passphrase-here" };
const levels = (n: ReturnType<typeof setupNotes>) => n.map((x) => x.level);
const texts = (n: ReturnType<typeof setupNotes>) => n.map((x) => x.text).join("\n");

describe("setupNotes", () => {
  it("is quiet for a sensible local setup, apart from the optional OAuth hint", () => {
    const n = setupNotes(base);
    expect(levels(n)).toEqual(["info"]);
    expect(texts(n)).toMatch(/IMAP mailboxes work now/);
    expect(setupNotes({ ...base, GOOGLE_CLIENT_ID: "x" })).toEqual([]);
  });

  it("warns about plain http anywhere but localhost", () => {
    for (const url of ["http://192.168.1.10:3000", "http://unraid.local:3000", "http://hub.example.com"]) {
      const n = setupNotes({ ...base, APP_URL: url, GOOGLE_CLIENT_ID: "x" });
      expect(levels(n).filter((l) => l === "warn").length, url).toBeGreaterThan(0);
      expect(texts(n), url).toMatch(/plain http/);
    }
  });

  it("doesn't warn for localhost over http, or for https anywhere", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://hub.example.com", "https://192.168.1.10"]) {
      expect(texts(setupNotes({ ...base, APP_URL: url, GOOGLE_CLIENT_ID: "x" })), url).not.toMatch(/plain http/);
    }
  });

  it("explains why Gmail or Outlook sign-in will fail over plain http, only when one is configured", () => {
    const off = setupNotes({ ...base, APP_URL: "http://192.168.1.10:3000" });
    expect(texts(off)).not.toMatch(/Google and Microsoft only accept/);
    expect(texts(setupNotes({ ...base, APP_URL: "http://192.168.1.10:3000", GOOGLE_CLIENT_ID: "x" }))).toMatch(/Google and Microsoft only accept/);
    expect(texts(setupNotes({ ...base, APP_URL: "http://192.168.1.10:3000", MICROSOFT_CLIENT_ID: "x" }))).toMatch(/Google and Microsoft only accept/);
  });

  it("warns about a short admin password", () => {
    expect(texts(setupNotes({ ...base, ADMIN_PASSWORD: "eleven-char", GOOGLE_CLIENT_ID: "x" }))).toMatch(/password is short/);
    expect(texts(setupNotes({ ...base, ADMIN_PASSWORD: "twelve-chars", GOOGLE_CLIENT_ID: "x" }))).not.toMatch(/password is short/);
  });

  it("copes with an unparseable APP_URL", () => {
    expect(() => setupNotes({ ...base, APP_URL: "not a url" })).not.toThrow();
  });
});

describe("placeholder admin passwords", () => {
  const set = (pw: string) => {
    process.env.ADMIN_PASSWORD = pw;
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.DATABASE_URL = "postgres://x:y@localhost:5432/z";
    resetEnvCache();
  };
  afterEach(() => resetEnvCache());

  it("refuses the value from the example file and other common defaults, in any case", () => {
    for (const pw of ["change-me", "CHANGE-ME", "changeme", "password", "Password", "12345678", "ghosthub", "Ghost-Hub"]) {
      set(pw);
      expect(() => getEnv(), pw).toThrow(/placeholder/);
    }
  });

  it("accepts a real password", () => {
    set("correct-horse-battery");
    expect(getEnv().ADMIN_PASSWORD).toBe("correct-horse-battery");
  });
});
