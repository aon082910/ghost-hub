import { describe, expect, it } from "vitest";
import type { ProfileRow } from "./store";
import { buildGroups } from "./view";

let n = 0;
const row = (o: Partial<ProfileRow> & Pick<ProfileRow, "identifierType" | "identifier" | "site" | "status">): ProfileRow => ({
  id: `id${++n}`,
  url: null,
  detail: null,
  checkedAt: new Date("2026-06-01T10:00:00Z"),
  ...o,
});

describe("buildGroups", () => {
  it("makes a group per identifier even before anything is checked, usernames first", () => {
    const g = buildGroups([], ["alice"], ["me@gmail.com"]);
    expect(g.map((x) => [x.type, x.identifier, x.checkedAt])).toEqual([["username", "alice", null], ["email", "me@gmail.com", null]]);
  });

  it("splits found, not found and unclear, naming sites properly", () => {
    const [g] = buildGroups(
      [
        row({ identifierType: "username", identifier: "alice", site: "github", status: "found", url: "https://github.com/alice" }),
        row({ identifierType: "username", identifier: "alice", site: "codeberg", status: "not_found" }),
        row({ identifierType: "username", identifier: "alice", site: "lichess", status: "not_found" }),
        row({ identifierType: "username", identifier: "alice", site: "steam", status: "error", detail: "The site blocks automated requests" }),
      ],
      ["alice"],
      [],
    );
    expect(g.found).toEqual([{ key: "github", name: "GitHub", url: "https://github.com/alice", via: undefined }]);
    expect(g.notFound).toBe(2);
    expect(g.unclear).toEqual([{ name: "Steam", detail: "The site blocks automated requests" }]);
  });

  it("shows Gravatar first and its linked accounts after, labelled as linked", () => {
    const e = "me@gmail.com";
    const [g] = buildGroups(
      [
        row({ identifierType: "email", identifier: e, site: "linked:mastodon-1", status: "found", url: "https://mastodon.social/@me", detail: "Mastodon" }),
        row({ identifierType: "email", identifier: e, site: "gravatar", status: "found", url: "https://gravatar.com/me" }),
        row({ identifierType: "email", identifier: e, site: "linked:github-0", status: "found", url: "https://github.com/me", detail: "GitHub" }),
      ],
      [],
      [e],
    );
    expect(g.found.map((f) => [f.name, f.via])).toEqual([["Gravatar", undefined], ["GitHub", "Gravatar"], ["Mastodon", "Gravatar"]]);
  });

  it("never turns a non-https stored URL into a link", () => {
    const [g] = buildGroups(
      [
        row({ identifierType: "username", identifier: "alice", site: "github", status: "found", url: "javascript:alert(1)" }),
        row({ identifierType: "username", identifier: "alice", site: "codeberg", status: "found", url: "http://codeberg.org/alice" }),
        row({ identifierType: "username", identifier: "alice", site: "lichess", status: "found", url: null }),
        row({ identifierType: "username", identifier: "alice", site: "keybase", status: "found", url: "https://keybase.io/alice" }),
      ],
      ["alice"],
      [],
    );
    expect(g.found.map((f) => f.key)).toEqual(["keybase"]);
  });

  it("ignores results for identifiers that are no longer on the list, and keeps the latest check time", () => {
    const groups = buildGroups(
      [
        row({ identifierType: "username", identifier: "removed", site: "github", status: "found", url: "https://github.com/removed" }),
        row({ identifierType: "username", identifier: "alice", site: "github", status: "not_found", checkedAt: new Date("2026-06-01T09:00:00Z") }),
        row({ identifierType: "username", identifier: "alice", site: "codeberg", status: "not_found", checkedAt: new Date("2026-06-02T09:00:00Z") }),
      ],
      ["alice"],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].checkedAt?.toISOString()).toBe("2026-06-02T09:00:00.000Z");
  });

  it("falls back to the site id for unknown sites and a generic reason for blank ones", () => {
    const [g] = buildGroups(
      [
        row({ identifierType: "username", identifier: "alice", site: "removed-site", status: "found", url: "https://x.example.org/alice" }),
        row({ identifierType: "username", identifier: "alice", site: "other-gone", status: "error", detail: null }),
      ],
      ["alice"],
      [],
    );
    expect(g.found[0].name).toBe("removed-site");
    expect(g.unclear[0]).toEqual({ name: "other-gone", detail: "Couldn't check" });
  });
});
