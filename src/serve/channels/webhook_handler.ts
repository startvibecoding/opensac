// Ported from internal/serve/channels/webhook_handler.go — WebhookHandler
// implements webhook.Handler by spawning agent tasks through the dispatcher's
// AgentManager.
//
// Deviations: Go's context.Context maps to an AbortSignal; the agent event
// channel loop maps to an async iteration over the run; the fire-and-forget
// delivery goroutine stays synchronous (platform SendMessage is async and
// awaited inside the task).

import type { Platform } from "../../messaging/mod.ts";
import type { RouteConfig } from "../webhook/router.ts";
import type { Dispatcher } from "./dispatcher.ts";

/**
 * WebhookHandler spawns a sub-agent for each accepted webhook event.
 */
export class WebhookHandler {
  #dispatcher: Dispatcher;
  #platforms: Map<string, Platform>;

  constructor(dispatcher: Dispatcher, platforms: Map<string, Platform>) {
    this.#dispatcher = dispatcher;
    this.#platforms = platforms;
  }

  /** SetPlatforms replaces the platform map after construction. */
  setPlatforms(platforms: Map<string, Platform>): void {
    this.#platforms = platforms;
  }

  /**
   * HandleWebhookEvent processes an incoming webhook event by spawning an
   * agent task.
   */
  async handleWebhookEvent(
    signal: AbortSignal,
    route: RouteConfig,
    payload: Uint8Array,
  ): Promise<void> {
    const agentMgr = this.#dispatcher.agentMgr;
    if (agentMgr === null || agentMgr === undefined) {
      throw new Error("webhook requires --multi-agent mode");
    }

    // Build prompt from webhook event
    const prompt =
      `Process this webhook event (route: ${route.path}, skill: ${route.skill}):\n\n${
        new TextDecoder().decode(payload)
      }`;

    // Create a sub-agent to handle the task
    let a;
    try {
      a = agentMgr.create({
        isSubAgent: true,
        mode: "yolo",
        workDir: this.#dispatcher.cfg?.getWorkDir() ?? "",
      });
    } catch (err) {
      throw new Error(`create webhook agent: ${message(err)}`);
    }

    // Run agent and collect result
    let result = "";
    let lastErr: Error | null = null;
    try {
      for await (const ev of a.run(prompt, signal)) {
        if (ev.error) lastErr = ev.error;
        // Collect text deltas from the underlying agent loop events
        if (ev.textDelta) result += ev.textDelta;
      }
    } finally {
      // Clean up
      agentMgr.destroy(a.id());
    }

    if (lastErr !== null) {
      throw new Error(`webhook agent error: ${message(lastErr)}`);
    }

    // Deliver result if configured
    if (route.delivery !== "" && result !== "") {
      this.deliverResult(route.delivery, route.deliveryTarget ?? "", result);
    }

    console.error(
      `[webhook] Task completed for route ${route.path} (result len=${result.length})`,
    );
  }

  /** deliverResult sends the result to the configured messaging platform. */
  deliverResult(platform: string, target: string, result: string): void {
    const p = this.#platforms.get(platform);
    if (p === undefined) {
      console.error(`[webhook] Delivery platform "${platform}" not found`);
      return;
    }
    if (target === "") {
      console.error(`[webhook] Delivery target missing for ${platform}`);
      return;
    }
    p.sendMessage(new AbortController().signal, target, result).catch((err) => {
      console.error(`[webhook] Delivery error to ${platform}: ${err}`);
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
