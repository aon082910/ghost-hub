export type ParsedUnsubscribe = { https: string[]; http: string[]; mailto: string[] };

const MAX_PER_KIND = 5;

/**
 * Pull the `<...>` entries out of a List-Unsubscribe header (RFC 2369). The value is attacker-controlled text from
 * an email, so entries are only sorted by scheme here, never trusted: anything that will be requested still goes
 * through assertSafeUrl first.
 */
export function parseListUnsubscribe(header: string | null | undefined): ParsedUnsubscribe {
  const out: ParsedUnsubscribe = { https: [], http: [], mailto: [] };
  if (!header) return out;
  for (const m of header.matchAll(/<([^<>]{1,2048})>/g)) {
    const value = m[1].trim();
    if (/[\u0000-\u001f\u007f\s]/.test(value)) continue; // control characters and whitespace never belong in a link
    const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
    if (scheme === "https" && out.https.length < MAX_PER_KIND && canParse(value)) out.https.push(value);
    else if (scheme === "http" && out.http.length < MAX_PER_KIND && canParse(value)) out.http.push(value);
    else if (scheme === "mailto" && out.mailto.length < MAX_PER_KIND && isMailto(value)) out.mailto.push(value);
  }
  return out;
}

function canParse(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** `mailto:name@host` with optional `?subject=...&body=...`. Rejects anything that isn't a plain address. */
export function isMailto(value: string): boolean {
  const m = /^mailto:([^?]+)(\?.*)?$/i.exec(value);
  if (!m) return false;
  let address: string;
  try {
    address = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  return /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/.test(address);
}

export type UnsubscribeMethod =
  | { method: "one-click"; url: string }
  | { method: "link"; url: string }
  | { method: "mailto"; mailto: string }
  | { method: "none" };

/**
 * How a sender can be unsubscribed from. Only RFC 8058 one-click (an https link plus the one-click flag) is done
 * automatically. A plain link may need a confirmation page, and a GET must never change state, so the user opens
 * it. `mailto` needs an email sent, which a read-only mailbox connection can't do, so the user's own mail app does.
 */
export function chooseMethod(listUnsubscribe: string | null | undefined, oneClick: boolean): UnsubscribeMethod {
  const parsed = parseListUnsubscribe(listUnsubscribe);
  const url = parsed.https[0];
  if (url && oneClick) return { method: "one-click", url };
  if (url) return { method: "link", url };
  if (parsed.mailto[0]) return { method: "mailto", mailto: parsed.mailto[0] };
  return { method: "none" };
}
