import { describe, expect, it } from "vitest";
import { groupByCompany } from "./companies";

describe("groupByCompany (real deletion-guide dataset)", () => {
  it("joins the domains one company emails from", () => {
    const groups = groupByCompany(["amazon.com", "github.com", "amazon.co.uk", "amazon.de"]);
    expect(groups).toEqual([["amazon.com", "amazon.co.uk", "amazon.de"], ["github.com"]]);
  });

  it("leaves unrelated companies apart", () => {
    const input = ["spotify.com", "netflix.com", "paypal.com", "dropbox.com", "adobe.com"];
    expect(groupByCompany(input)).toEqual(input.map((d) => [d]));
  });

  it("never merges domains that have no guide, however alike their names", () => {
    const input = ["quietbank.co.uk", "quietbank.com", "totally-unknown-shop.example"];
    expect(groupByCompany(input)).toEqual(input.map((d) => [d]));
  });

  it("is deterministic and keeps the order it was given", () => {
    const a = groupByCompany(["ebay.de", "paypal.com", "ebay.com", "ebay.co.uk"]);
    expect(a).toEqual([["ebay.de", "ebay.com", "ebay.co.uk"], ["paypal.com"]]);
    expect(groupByCompany(["ebay.de", "paypal.com", "ebay.com", "ebay.co.uk"])).toEqual(a);
  });

  it("ignores case and duplicates, and handles an empty list", () => {
    expect(groupByCompany(["Amazon.com", "amazon.com", "AMAZON.CO.UK"])).toEqual([["amazon.com", "amazon.co.uk"]]);
    expect(groupByCompany([])).toEqual([]);
  });

  it("every input domain lands in exactly one group", () => {
    const input = ["amazon.com", "audible.com", "microsoft.com", "live.com", "xbox.com", "office.com", "github.com", "apple.com", "icloud.com", "x.example"];
    const flat = groupByCompany(input).flat();
    expect([...flat].sort()).toEqual([...input].sort());
  });
});
