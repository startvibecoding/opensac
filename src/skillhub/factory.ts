import type { SkillHubSettings } from "../config/settings.ts";
import { createClawHubClient } from "./clawhub.ts";
import { defaultHttpClient, type HttpClient } from "./http.ts";
import { createSkillHubClient } from "./skillhubcn.ts";
import type { Market, MarketClient } from "./types.ts";

/**
 * Constructs the enabled built-in market clients from settings.
 *
 * Custom IDs are reserved for future adapters and are ignored rather than
 * silently treating an incompatible API as SkillHub or ClawHub.
 */
export function clientsForSettings(
  settings: SkillHubSettings,
): MarketClient[] {
  const markets = settings.markets ?? [];
  if (markets.length === 0) {
    return [
      createSkillHubClient("", undefined),
      createClawHubClient("", undefined),
    ];
  }
  const clients: MarketClient[] = [];
  for (const market of markets) {
    if (!market.enabled) continue;
    const baseURL = (market.apiURL ?? "").trim();
    const client = httpClientWithToken(market.apiToken);
    switch (market.id as Market) {
      case "skillhub.cn":
        clients.push(createSkillHubClient(baseURL, client));
        break;
      case "clawhub.ai":
        clients.push(createClawHubClient(baseURL, client));
        break;
    }
  }
  return clients;
}

/** Wraps the default client to send a bearer token, when configured. */
export function httpClientWithToken(token?: string): HttpClient | undefined {
  if (!token || token.trim() === "") return undefined;
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer " + token);
    return defaultHttpClient(url, { ...init, headers });
  };
}
