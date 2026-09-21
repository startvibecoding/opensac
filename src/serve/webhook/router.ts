// Ported from internal/serve/webhook/router.go — inbound webhook routing for
// serve channels. External services (GitHub, CI, etc.) POST events to
// /webhook/<path>, which are verified and dispatched to agent tasks.
//
// Deviations: net/http handlers map to (Request → Response); the goroutine
// dispatch to the handler maps to a fire-and-forget async task; the 10MB body
// limit is enforced by reading the body fully and checking its length.

import { createHmac } from "node:crypto";

/** RouteConfig defines a webhook route. */
export interface RouteConfig {
  path: string;
  events: string[];
  skill: string;
  /** "wechat", "feishu", or "" (no delivery). */
  delivery: string;
  deliveryTarget?: string;
}

/** Handler processes incoming webhook events. */
export interface Handler {
  handleWebhookEvent(
    route: RouteConfig,
    payload: Uint8Array,
  ): Promise<void> | void;
}

/** Router manages webhook routes and dispatches events. */
export class Router {
  #routes: RouteConfig[];
  #secret: string;
  #handler: Handler | null;

  constructor(routes: RouteConfig[], secret: string, handler: Handler | null) {
    this.#routes = routes;
    this.#secret = secret;
    this.#handler = handler;
  }

  /** Handles incoming webhook requests. Expected path: /webhook/<route-path>. */
  async handler(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return textResponse("method not allowed\n", 405);
    }

    // Extract the route path from URL
    const url = new URL(req.url);
    let path = url.pathname.startsWith("/webhook")
      ? url.pathname.slice("/webhook".length)
      : url.pathname;
    if (path === "") {
      path = "/";
    }

    // Find matching route
    const route = this.#routes.find((r) => r.path === path);
    if (!route) {
      return textResponse("no route for path: " + path + "\n", 404);
    }

    // Read body (10MB limit)
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > 10 * 1024 * 1024) {
      return textResponse("read body error\n", 400);
    }

    // Verify signature if secret is configured
    if (this.#secret !== "") {
      let sig = req.headers.get("X-Hub-Signature-256") ?? "";
      if (sig === "") {
        sig = req.headers.get("X-Signature-256") ?? "";
      }
      if (!verifySignature(body, sig, this.#secret)) {
        return textResponse("invalid signature\n", 401);
      }
    }

    // Check event type filter
    let eventType = req.headers.get("X-GitHub-Event") ?? "";
    if (eventType === "") {
      // Try to extract from body
      try {
        const generic = JSON.parse(new TextDecoder().decode(body)) as {
          action?: string;
          type?: string;
        };
        if (generic.action) {
          eventType = generic.action;
        } else if (generic.type) {
          eventType = generic.type;
        }
      } catch (err) {
        console.error(
          `[webhook] Failed to parse body for event type on ${path}: ${err}`,
        );
      }
    }

    if (!routeMatchesEvent(route.events, eventType)) {
      // Event type not in filter — acknowledge but skip
      return Response.json({
        status: "skipped",
        reason: "event type not matched",
      });
    }

    // Dispatch to handler
    console.error(
      `[webhook] Received event on ${path} (type: ${eventType}, ${body.byteLength} bytes)`,
    );

    if (this.#handler) {
      const handler = this.#handler;
      const snapshot = { ...route };
      void (async () => {
        try {
          await handler.handleWebhookEvent(snapshot, body);
        } catch (err) {
          console.error(`[webhook] Handler error for ${path}: ${err}`);
        }
      })();
    }

    return Response.json({ status: "accepted" });
  }
}

/** Verifies an HMAC-SHA256 signature (`sha256=` prefixed or bare hex). */
export function verifySignature(
  body: Uint8Array,
  signature: string,
  secret: string,
): boolean {
  if (signature === "") {
    return false;
  }

  // Strip "sha256=" prefix
  const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  const expected = createHmac("sha256", secret).update(body).digest("hex");

  return timingSafeEqual(sig, expected);
}

/** Constant-time string comparison, matching Go's hmac.Equal semantics. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function routeMatchesEvent(
  events: string[],
  eventType: string,
): boolean {
  if (events.length === 0) {
    return true;
  }
  for (const ev of events) {
    if (ev === "*") {
      return true;
    }
    if (eventType !== "" && ev === eventType) {
      return true;
    }
  }
  return false;
}
