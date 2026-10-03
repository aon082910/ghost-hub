import type { OAuthProvider } from "./core";
import { google } from "./google";
import { microsoft } from "./microsoft";

export * from "./core";

export const OAUTH_PROVIDERS = { google, microsoft } satisfies Record<string, OAuthProvider>;
export type OAuthProviderId = keyof typeof OAUTH_PROVIDERS;

export function isOAuthProviderId(id: string): id is OAuthProviderId {
  return Object.hasOwn(OAUTH_PROVIDERS, id);
}

export function getOAuthProvider(id: string): OAuthProvider | null {
  return isOAuthProviderId(id) ? OAUTH_PROVIDERS[id] : null;
}
