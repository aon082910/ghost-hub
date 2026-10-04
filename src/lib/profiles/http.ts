import https from "node:https";
import { allowPrivateTargets, assertSafeUrl, safeLookup } from "../newsletters/ssrf";

export const USER_AGENT = "Ghost-Hub (self-hosted profile check; +https://github.com/aon082910/ghost-hub)";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const MAX_HOPS = 3;

export type GetRequest = {
  url: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  lookup?: typeof safeLookup;
};
export type GetResponse = { status: number; location?: string; body: string };
export type GetTransport = (req: GetRequest) => Promise<GetResponse>;

/** One HTTPS GET that reads at most `maxBytes` of the body and never follows a redirect on its own. */
export const httpsGet: GetTransport = ({ url, headers, timeoutMs, maxBytes, lookup }) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        lookup,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode ?? 0, location, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size >= maxBytes) {
            finish();
            res.destroy(); // enough to decide; don't download the rest of a big page
          }
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", () => finish());
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });

export type Page =
  | { kind: "ok"; status: number; body: string }
  /** The site sent us to a different host (a consent wall, a login page...). We don't follow it. */
  | { kind: "redirected_away"; host: string };

/**
 * GET a public page. Every hop is validated like the first request, only same-host redirects are followed (a few
 * hops), and anything pointing at a private address is refused. Throws UnsafeUrlError or a network error.
 */
export async function fetchPage(rawUrl: string, transport: GetTransport = httpsGet): Promise<Page> {
  let url = assertSafeUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await transport({
      url,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en" },
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      lookup: allowPrivateTargets() ? undefined : safeLookup,
    });
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        return { kind: "ok", status: res.status, body: "" };
      }
      if (next.hostname !== url.hostname) return { kind: "redirected_away", host: next.hostname };
      if (hop >= MAX_HOPS) return { kind: "ok", status: res.status, body: "" };
      url = assertSafeUrl(next.href);
      continue;
    }
    return { kind: "ok", status: res.status, body: res.body };
  }
}
