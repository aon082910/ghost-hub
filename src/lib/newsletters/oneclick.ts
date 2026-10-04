import https from "node:https";
import { UnsafeUrlError, allowPrivateTargets, assertSafeUrl, safeLookup } from "./ssrf";

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click"; // RFC 8058
export const USER_AGENT = "Ghost-Hub (self-hosted unsubscribe; +https://github.com/aon082910/ghost-hub)";
const TIMEOUT_MS = 15_000;

export type TransportRequest = {
  url: URL;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Set unless private targets are allowed (dev only). Validates the address at connect time. */
  lookup?: typeof safeLookup;
};
export type TransportResponse = { status: number; location?: string };
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/**
 * One HTTPS POST. Redirects are not followed and the response body is never read: the status line is all we need,
 * and a hostile server can neither bounce us to an internal address nor make us download something huge.
 */
export const httpsTransport: Transport = ({ url, body, headers, timeoutMs, lookup }) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        resolve({ status: res.statusCode ?? 0, location });
        res.destroy(); // don't read the body
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });

export type UnsubscribeOutcome =
  | { ok: true; status: number }
  | { ok: false; reason: "blocked" | "redirect" | "http_error" | "timeout" | "network"; status?: number; message: string };

/** Send the RFC 8058 one-click POST. Never throws: every failure comes back as a described outcome. */
export async function unsubscribeOneClick(rawUrl: string, transport: Transport = httpsTransport): Promise<UnsubscribeOutcome> {
  let url: URL;
  try {
    url = assertSafeUrl(rawUrl);
  } catch (err) {
    if (err instanceof UnsafeUrlError) return { ok: false, reason: "blocked", message: err.message };
    throw err;
  }

  try {
    const res = await transport({
      url,
      body: ONE_CLICK_BODY,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
        accept: "*/*",
      },
      timeoutMs: TIMEOUT_MS,
      lookup: allowPrivateTargets() ? undefined : safeLookup,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        reason: "redirect",
        status: res.status,
        message: "The sender redirected to another page. Open the unsubscribe link yourself to finish.",
      };
    }
    return { ok: false, reason: "http_error", status: res.status, message: `The sender's server answered HTTP ${res.status}.` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOTPUBLIC") {
      return { ok: false, reason: "blocked", message: "The sender's address points at a private network, so Ghost-Hub won't contact it." };
    }
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      return { ok: false, reason: "timeout", message: "The sender's server took too long to respond." };
    }
    return { ok: false, reason: "network", message: "Couldn't reach the sender's server." };
  }
}
