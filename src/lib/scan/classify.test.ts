import { describe, expect, it } from "vitest";
import { classify, parseAddress, parseHeaderBlock, registrableDomain, serviceName } from "./classify";
import type { MessageHeader } from "./types";

const ME = "me@gmail.com";
const msg = (o: Partial<MessageHeader> & { fromEmail: string; subject: string }): MessageHeader => ({
  id: "1",
  date: new Date("2024-01-01"),
  fromName: null,
  ...o,
});
const cat = (o: Parameters<typeof msg>[0], own = ME) => classify(msg(o), own)?.category ?? null;

describe("registrableDomain", () => {
  it("collapses subdomains and handles multi-part suffixes", () => {
    expect(registrableDomain("a@em.paypal.com")).toBe("paypal.com");
    expect(registrableDomain("a@accounts.google.com")).toBe("google.com");
    expect(registrableDomain("a@mail.example.co.uk")).toBe("example.co.uk");
  });

  it("rejects IPs, bare hosts, unknown TLDs and garbage", () => {
    for (const e of ["a@10.0.0.1", "a@localhost", "a@foo.invalid", "nope", "a@", ""]) {
      expect(registrableDomain(e), e).toBeNull();
    }
  });
});

describe("account signals", () => {
  it.each([
    "Welcome to Dropbox!",
    "Thanks for signing up",
    "Thank you for registering with us",
    "Please verify your email address",
    "Confirm your account",
    "Activate your account",
    "Your account has been created",
    "Reset your password",
    "Your password was changed",
    "New sign-in to your account",
    "Security alert: unusual login",
    "Your verification code",
    "Your one-time code is 123456",
    "Complete your registration",
  ])("%s → account", (subject) => {
    expect(cat({ fromEmail: "team@example.com", subject })).toBe("account");
  });
});

describe("billing and order signals", () => {
  it.each(["Your subscription is renewing", "Your membership", "Your free trial ends soon", "Payment failed", "Upcoming charge"])(
    "%s → subscription",
    (subject) => expect(cat({ fromEmail: "team@example.com", subject })).toBe("subscription"),
  );

  it.each(["Your receipt from Example", "Order confirmation #123", "Your order has shipped", "Invoice INV-9", "Thank you for your purchase", "Shipping update"])(
    "%s → receipt",
    (subject) => expect(cat({ fromEmail: "team@example.com", subject })).toBe("receipt"),
  );
});

describe("priority", () => {
  it("account beats billing beats receipt", () => {
    expect(cat({ fromEmail: "a@example.com", subject: "Welcome to Pro: your subscription receipt" })).toBe("account");
    expect(cat({ fromEmail: "a@example.com", subject: "Subscription receipt" })).toBe("subscription");
  });

  it("an account email that also carries List-Unsubscribe stays 'account' but still records the newsletter", () => {
    const c = classify(
      msg({ fromEmail: "hello@example.com", subject: "Welcome to Example", listUnsubscribe: "<https://example.com/u>" }),
      ME,
    )!;
    expect(c.category).toBe("account");
    expect(c.newsletter).not.toBeNull();
  });
});

describe("newsletters", () => {
  it("bulk mail with List-Unsubscribe is a newsletter and keeps the link", () => {
    const c = classify(
      msg({ fromEmail: "news@shop.com", fromName: "Shop", subject: "Big sale this weekend", listUnsubscribe: "<https://shop.com/u?id=1>, <mailto:u@shop.com>" }),
      ME,
    )!;
    expect(c.category).toBe("newsletter");
    expect(c.newsletter).toEqual({
      senderEmail: "news@shop.com",
      senderName: "Shop",
      listUnsubscribe: "<https://shop.com/u?id=1>, <mailto:u@shop.com>",
      oneClick: false,
    });
  });

  it("one-click needs both List-Unsubscribe-Post and an https URL", () => {
    const base = { fromEmail: "n@shop.com", subject: "Sale", listUnsubscribePost: "List-Unsubscribe=One-Click" };
    expect(classify(msg({ ...base, listUnsubscribe: "<https://shop.com/u>" }), ME)!.newsletter!.oneClick).toBe(true);
    expect(classify(msg({ ...base, listUnsubscribe: "<mailto:u@shop.com>" }), ME)!.newsletter!.oneClick).toBe(false);
    expect(classify(msg({ fromEmail: "n@shop.com", subject: "Sale", listUnsubscribe: "<https://shop.com/u>" }), ME)!.newsletter!.oneClick).toBe(false);
  });

  it("List-Id or Precedence: bulk also mark a newsletter, without an unsubscribe link", () => {
    const c = classify(msg({ fromEmail: "digest@forum.com", subject: "Weekly digest", listId: "<digest.forum.com>" }), ME)!;
    expect(c.category).toBe("newsletter");
    expect(c.newsletter).toMatchObject({ listUnsubscribe: null, oneClick: false });
    expect(cat({ fromEmail: "x@forum.com", subject: "Hello", precedence: "bulk" })).toBe("newsletter");
  });

  it("truncates absurdly long List-Unsubscribe values", () => {
    const c = classify(msg({ fromEmail: "n@shop.com", subject: "x", listUnsubscribe: "<https://shop.com/" + "a".repeat(5000) + ">" }), ME)!;
    expect(c.newsletter!.listUnsubscribe!.length).toBe(2000);
  });
});

describe("transactional senders", () => {
  it.each(["noreply", "no-reply", "do-not-reply", "donotreply", "notifications", "security", "billing", "orders", "alerts"])(
    "%s@ with a neutral subject → account",
    (local) => expect(cat({ fromEmail: `${local}@service.com`, subject: "Update about your activity" })).toBe("account"),
  );

  it("a no-reply sender that is clearly marketing (list headers) is a newsletter, not an account", () => {
    expect(cat({ fromEmail: "noreply@shop.com", subject: "Deals", listUnsubscribe: "<https://shop.com/u>" })).toBe("newsletter");
  });

  it("human-ish local parts alone are not enough", () => {
    for (const local of ["support", "info", "hello", "team", "john"]) {
      expect(cat({ fromEmail: `${local}@service.com`, subject: "Quick question" }), local).toBeNull();
    }
  });
});

describe("things that must not count", () => {
  it("'Welcome back' style marketing is not an account signal", () => {
    expect(cat({ fromEmail: "john@service.com", subject: "Welcome back! 20% off" })).toBeNull();
  });

  it("ignores mail from free providers (people, not services)", () => {
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me"]) {
      expect(classify(msg({ fromEmail: `friend@${d}`, subject: "Welcome to the family!" }), ME), d).toBeNull();
    }
  });

  it("ignores the user's own address and, for custom domains, their own domain", () => {
    expect(classify(msg({ fromEmail: "ME@gmail.com", subject: "Receipt" }), ME)).toBeNull();
    expect(classify(msg({ fromEmail: "bob@mydomain.com", subject: "Invoice" }), "me@mydomain.com")).toBeNull();
    expect(classify(msg({ fromEmail: "x@other.com", subject: "Invoice" }), "me@mydomain.com")).not.toBeNull();
  });

  it("ignores unparseable senders", () => {
    expect(classify(msg({ fromEmail: "", subject: "Receipt" }), ME)).toBeNull();
    expect(classify(msg({ fromEmail: "not-an-email", subject: "Receipt" }), ME)).toBeNull();
    expect(classify(msg({ fromEmail: "a@10.0.0.1", subject: "Receipt" }), ME)).toBeNull();
  });

  it("returns a null category (but still a domain) for ordinary person-to-person mail", () => {
    const c = classify(msg({ fromEmail: "alice@university.edu", subject: "Lunch tomorrow?" }), ME)!;
    expect(c.category).toBeNull();
    expect(c.domain).toBe("university.edu");
  });
});

describe("service names", () => {
  it("title-cases the domain label by default", () => {
    expect(serviceName("paypal.com", null)).toBe("Paypal");
    expect(serviceName("my-bank.co.uk", null)).toBe("My-Bank");
  });

  it("uses the sender's casing when it names the service", () => {
    expect(serviceName("paypal.com", "PayPal")).toBe("PayPal");
    expect(serviceName("github.com", '"GitHub" ')).toBe("GitHub");
    expect(serviceName("netflix.com", "Netflix Support")).toBe("Netflix");
    expect(serviceName("my-bank.com", "My Bank")).toBe("My Bank");
  });

  it("ignores display names that are people or unrelated", () => {
    expect(serviceName("example.com", "Jane Doe")).toBe("Example");
    expect(serviceName("example.com", "The Weekly Digest")).toBe("Example");
  });
});

describe("address and header parsing", () => {
  it("parses name-addr and bare addresses", () => {
    expect(parseAddress('"PayPal, Inc." <Service@Paypal.com>')).toEqual({ email: "service@paypal.com", name: "PayPal, Inc." });
    expect(parseAddress("Jane <jane@x.com>")).toEqual({ email: "jane@x.com", name: "Jane" });
    expect(parseAddress("<a@b.com>")).toEqual({ email: "a@b.com", name: null });
    expect(parseAddress("a@b.com")).toEqual({ email: "a@b.com", name: null });
    expect(parseAddress("garbage")).toBeNull();
  });

  it("unfolds continuation lines, lowercases names and keeps the first duplicate", () => {
    const raw = "From: A <a@b.com>\r\nList-Unsubscribe: <https://x.com/u>,\r\n <mailto:u@x.com>\r\nSubject: one\r\nSubject: two\r\n\r\n";
    expect(parseHeaderBlock(raw)).toEqual({
      from: "A <a@b.com>",
      "list-unsubscribe": "<https://x.com/u>, <mailto:u@x.com>",
      subject: "one",
    });
  });
});
