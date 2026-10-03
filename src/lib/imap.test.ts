import { describe, expect, it, vi } from "vitest";
import { IMAP_PORT, ImapConnectError, parseImapForm, verifyImapLogin, type ImapClientLike } from "./imap";

const form = (o: Record<string, string>) => ({ preset: "yahoo", email: "Me@Yahoo.com", password: "app-pass", ...o });

describe("parseImapForm", () => {
  it("resolves Yahoo's server, lowercases the email and defaults to port 993", () => {
    expect(parseImapForm(form({}))).toEqual({
      ok: true,
      credentials: { host: "imap.mail.yahoo.com", port: IMAP_PORT, user: "me@yahoo.com", pass: "app-pass" },
    });
  });

  it("ignores a user-supplied host for presets (can't redirect Yahoo logins elsewhere)", () => {
    const r = parseImapForm(form({ host: "evil.example.com", port: "143" }));
    expect(r).toMatchObject({ ok: true, credentials: { host: "imap.mail.yahoo.com", port: 143 } });
  });

  it("requires a valid hostname for custom servers", () => {
    expect(parseImapForm(form({ preset: "custom", host: "mail.example.org" }))).toMatchObject({
      ok: true,
      credentials: { host: "mail.example.org" },
    });
    for (const host of ["", "localhost", "10.0.0.1", "a b.com", "http://x.com", "x.com/path", "-bad.com"]) {
      expect(parseImapForm(form({ preset: "custom", host })), `host=${host}`).toMatchObject({ ok: false });
    }
  });

  it("rejects bad emails, empty passwords, unknown presets and out-of-range ports", () => {
    expect(parseImapForm(form({ email: "nope" }))).toMatchObject({ ok: false });
    expect(parseImapForm(form({ password: "" }))).toMatchObject({ ok: false });
    expect(parseImapForm(form({ preset: "hotmail" }))).toMatchObject({ ok: false });
    expect(parseImapForm(form({ port: "0" }))).toMatchObject({ ok: false });
    expect(parseImapForm(form({ port: "70000" }))).toMatchObject({ ok: false });
    expect(parseImapForm({})).toMatchObject({ ok: false });
  });
});

const creds = { host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", pass: "s3cret-app-pass" };

function fakeClient(overrides: Partial<ImapClientLike> = {}): ImapClientLike & { close: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ messages: 321 }),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  } as never;
}

describe("verifyImapLogin", () => {
  it("connects, reads the inbox count and logs out", async () => {
    const client = fakeClient();
    const make = vi.fn(() => client);
    expect(await verifyImapLogin(creds, make)).toEqual({ messages: 321 });
    expect(make).toHaveBeenCalledWith(creds);
    expect(client.status).toHaveBeenCalledWith("INBOX", { messages: true });
    expect(client.logout).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it("tolerates a server that returns no status", async () => {
    const client = fakeClient({ status: vi.fn().mockResolvedValue(false) });
    expect(await verifyImapLogin(creds, () => client)).toEqual({ messages: null });
  });

  it("maps rejected credentials to auth_failed and closes the socket", async () => {
    const client = fakeClient({ connect: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { authenticationFailed: true })) });
    await expect(verifyImapLogin(creds, () => client)).rejects.toMatchObject({ name: "ImapConnectError", code: "auth_failed" });
    expect(client.close).toHaveBeenCalled();
  });

  it("maps network failures to unreachable", async () => {
    const client = fakeClient({ connect: vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) });
    await expect(verifyImapLogin(creds, () => client)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("never puts the password in an error message", async () => {
    for (const err of [Object.assign(new Error(creds.pass), { authenticationFailed: true }), new Error(creds.pass)]) {
      const client = fakeClient({ connect: vi.fn().mockRejectedValue(err) });
      const caught = await verifyImapLogin(creds, () => client).catch((e) => e);
      expect(caught).toBeInstanceOf(ImapConnectError);
      expect(caught.message).not.toContain(creds.pass);
    }
  });
});
