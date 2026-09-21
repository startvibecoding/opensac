// Translated from internal/serve/openaiapi/server_test.go's error-shaping
// cases, adapted to the Response-returning write helpers that auth.ts owns
// (they port server.go's writeJSON/writeError/writeErrorInfo).
import { assertEquals } from "@std/assert";
import { writeError, writeErrorInfo, writeJSON } from "./auth.ts";

async function body(resp: Response): Promise<Record<string, unknown>> {
  return await resp.json();
}

Deno.test("writeJSON encodes the payload with the JSON content type", async () => {
  const resp = writeJSON(201, { ok: true });
  assertEquals(resp.status, 201);
  assertEquals(resp.headers.get("content-type"), "application/json");
  assertEquals(await body(resp), { ok: true });
});

Deno.test("writeError preserves client-error messages and classifies the phase", async () => {
  const resp = writeError(400, "model is required", "invalid_request_error");
  assertEquals(resp.status, 400);
  const payload = await body(resp) as {
    error: Record<string, unknown>;
  };
  // The caller's type wins; the 4xx status classifies as retryable exactly
  // like Go (provider gateways use 4xx for transient failures).
  assertEquals(payload.error.type, "invalid_request_error");
  assertEquals(payload.error.message, "model is required");
  assertEquals(payload.error.phase, "admission");
  assertEquals(payload.error.retryable, true);
  assertEquals(payload.error.failureClass, "transient");
});

Deno.test("writeError marks server-side failures with the persistence phase", async () => {
  const resp = writeError(
    500,
    "internal failure detail",
    "server_error",
  );
  const payload = await body(resp) as { error: Record<string, unknown> };
  assertEquals(payload.error.type, "server_error");
  assertEquals(payload.error.phase, "persistence");
  assertEquals(payload.error.retryable, true);
  // Go's blanked override falls back to the classified diagnostic, so the
  // detail survives here too (verified against internal/agentruntime).
  assertEquals(payload.error.message, "internal failure detail");
});

Deno.test("writeErrorInfo renders the classified error detail", async () => {
  const resp = writeErrorInfo(429, {
    message: "slow down",
    type: "provider_error",
    code: "rate_limited",
    retryable: true,
    retryAfterMs: 2500,
    attempt: 2,
    maxAttempts: 3,
    phase: "model",
    failureClass: "transient",
    retryMode: "automatic",
    sideEffectState: "read_only",
  });
  assertEquals(resp.status, 429);
  assertEquals(resp.headers.get("retry-after"), "3");
  const payload = await body(resp) as { error: Record<string, unknown> };
  assertEquals(payload.error.code, "rate_limited");
  assertEquals(payload.error.message, "slow down");
  assertEquals(payload.error.retryable, true);
  assertEquals(payload.error.attempt, 2);
  assertEquals(payload.error.maxAttempts, 3);
  assertEquals(payload.error.sideEffectState, "read_only");
});

Deno.test("writeErrorInfo substitutes the generic message and type", async () => {
  const resp = writeErrorInfo(500, { message: "" });
  const payload = await body(resp) as { error: Record<string, unknown> };
  assertEquals(
    payload.error.message,
    "The request could not be completed.",
  );
  assertEquals(payload.error.type, "server_error");
});
