import { describe, expect, it } from "vitest";
import { aggregate } from "./engine";
import type { MessageHeader } from "./types";
import { isSpamOnly } from "../dashboard";

const ME = "me@yahoo.com";
const msg = (id: string, from: string, subject: string, junk?: boolean, extra: Partial<MessageHeader> = {}): MessageHeader => ({
  id, date: new Date("2025-01-01T00:00:00Z"), fromEmail: from, fromName: null, subject, junk, ...extra,
});

describe("aggregate counts spam", () => {
  it("counts junk messages per service and per newsletter sender", () => {
    const r = aggregate(
      [
        msg("1", "hi@shop.com", "Welcome to Shop", false),
        msg("2", "hi@shop.com", "Your order receipt", true),
        msg("3", "x@junkco.com", "Verify your account", true),
        msg("4", "x@junkco.com", "Verify your account now", true),
        msg("5", "deals@mailer.com", "Big sale", true, { listUnsubscribe: "<https://mailer.com/u>" }),
        msg("6", "deals@mailer.com", "Bigger sale", false, { listUnsubscribe: "<https://mailer.com/u>" }),
      ],
      ME,
    );
    const acc = Object.fromEntries(r.accounts.map((a) => [a.domain, [a.count, a.spam]]));
    expect(acc["shop.com"]).toEqual([2, 1]);
    expect(acc["junkco.com"]).toEqual([2, 2]);
    const news = r.newsletters.find((n) => n.senderEmail === "deals@mailer.com")!;
    expect([news.count, news.spam]).toEqual([2, 1]);
  });

  it("a message with no junk flag is not spam", () => {
    const r = aggregate([msg("1", "hi@shop.com", "Welcome to Shop")], ME);
    expect(r.accounts[0].spam).toBe(0);
  });
});

describe("isSpamOnly", () => {
  it("is true only when there is mail and all of it was spam", () => {
    expect(isSpamOnly({ messages: 3, spamCount: 3 })).toBe(true);
    expect(isSpamOnly({ messages: 3, spamCount: 2 })).toBe(false);
    expect(isSpamOnly({ messages: 3, spamCount: 0 })).toBe(false);
    expect(isSpamOnly({ messages: 0, spamCount: 0 })).toBe(false);
  });
});
