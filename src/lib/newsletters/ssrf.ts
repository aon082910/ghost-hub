import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { devOverride } from "../dev-override";

/**
 * Unsubscribe links come out of emails, and anyone can send you an email. Before Ghost-Hub makes a request to
 * one, it must be sure the request can't be aimed at the user's own network (cloud metadata, the router, other
 * containers on the Unraid box...). Two layers: validate the URL, then validate the address the name resolves to
 * at connect time, so a DNS answer that changes between the check and the connection can't slip through.
 */

export class UnsafeUrlError extends Error {
  constructor(
    public readonly reason: "invalid" | "not_https" | "credentials" | "port" | "ip_literal" | "host" | "private_address",
    message: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const reserved = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  reserved.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments, including Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  reserved.addSubnet(net, prefix, "ipv6");
}

/**
 * True only for a globally routable unicast address. Anything unrecognised is treated as not public.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are refused outright. They can't be a blocklist subnet because
 * Node's BlockList matches plain IPv4 addresses against ::ffff:0:0/96 too, which would block everything.
 */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0 || address.includes("%")) return false;
  if (family === 6) {
    // URL normalisation gives one canonical spelling, so every way of writing a mapped address is caught.
    let canonical: string;
    try {
      canonical = new URL(`http://[${address}]/`).hostname;
    } catch {
      return false;
    }
    if (canonical.startsWith("[::ffff:")) return false;
  }
  return !reserved.check(address, family === 4 ? "ipv4" : "ipv6");
}

const BAD_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa", ".test", ".invalid", ".example"];

/** Local development and tests may point at a fake server on this machine. Ignored in production builds. */
export const allowPrivateTargets = () => devOverride("GHOSTHUB_ALLOW_PRIVATE_UNSUBSCRIBE", "") === "1";

/** Validate an unsubscribe URL for an automatic request. Throws UnsafeUrlError with a reason when it isn't acceptable. */
export function assertSafeUrl(raw: string): URL {
  if (raw.length > 2048) throw new UnsafeUrlError("invalid", "The unsubscribe link is too long.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("invalid", "The unsubscribe link isn't a valid web address.");
  }
  if (allowPrivateTargets()) return url;

  if (url.protocol !== "https:") throw new UnsafeUrlError("not_https", "Only https unsubscribe links are used automatically.");
  if (url.username || url.password) throw new UnsafeUrlError("credentials", "The unsubscribe link contains a username or password.");
  if (url.port !== "") throw new UnsafeUrlError("port", "The unsubscribe link uses a non-standard port.");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host) !== 0 || host.startsWith("[")) {
    throw new UnsafeUrlError("ip_literal", "The unsubscribe link points at an IP address instead of a website name.");
  }
  if (!host.includes(".") || BAD_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("host", "The unsubscribe link points at a name that isn't on the public internet.");
  }
  return url;
}

type Resolved = { address: string; family: number };
type Resolver = (hostname: string, options: dns.LookupOptions & { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: Resolved[]) => void) => void;

/**
 * A `lookup` function for http(s).request that refuses to connect to anything but public addresses. Because the
 * connection uses the address returned here, the check can't be sidestepped by DNS rebinding. If a name resolves
 * to several addresses and any is non-public, the whole name is refused.
 */
export function createSafeLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return function safeLookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | Resolved[], family?: number) => void,
  ) {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
        const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to a non-public address`);
        e.code = "ENOTPUBLIC";
        return callback(e, "", 0);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const safeLookup = createSafeLookup();
