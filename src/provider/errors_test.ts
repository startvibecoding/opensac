// Unit tests for the shared provider error wrapper.
//
// `transport_retry_test.ts` covers the retry outcomes these errors feed; this
// file pins the wrapper's own contract, because a dropped or duplicated link
// here is exactly what made a transport failure unclassifiable before: the whole
// point is that the real socket reason survives every wrap and reaches the
// classifier readable rather than as the opaque "fetch failed".

import { assert, assertEquals } from "@std/assert";
import { errorChainText, wrapError } from "./errors.ts";

Deno.test("errorChainText joins every link, oldest last", () => {
  const root = new Error("Connection refused (os error 111)");
  const mid = new Error("tcp connect error", { cause: root });
  const top = new TypeError("fetch failed", { cause: mid });
  const text = errorChainText(top);
  assert(text.includes("fetch failed"), text);
  assert(text.includes("tcp connect error"), text);
  assert(text.includes("Connection refused (os error 111)"), text);
  // Order matters only insofar as nothing is lost; assert the depth.
  assertEquals(text.split("\n").length, 3);
});

Deno.test("errorChainText skips empty messages and object noise", () => {
  // An empty-message wrapper must contribute nothing rather than a blank line.
  const blank = new Error("");
  blank.cause = new Error("real reason");
  assertEquals(errorChainText(blank), "real reason");

  // A plain-object cause has no usable description and stays out.
  assertEquals(
    errorChainText(new Error("top", { cause: { code: 42 } })),
    "top",
  );
});

Deno.test("errorChainText terminates on a cyclic cause chain", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  (a as { cause?: unknown }).cause = b;
  const text = errorChainText(a);
  assert(text.includes("a") && text.includes("b"), text);
  // Each link appears once: the walk must not loop.
  assertEquals(text.split("\n").length, 2);
});

Deno.test("wrapError keeps the original error as the cause", () => {
  const raw = new TypeError("fetch failed");
  const wrapped = wrapError("send request", raw);
  assert(wrapped instanceof Error);
  assertEquals(wrapped.cause, raw, "the chain must survive one wrap");
  assertEquals(wrapped.message, "send request: fetch failed");
});

Deno.test("wrapError names the deepest socket reason in the message", () => {
  const raw = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (https://api.test/v1): client error (Connect): tcp connect error: Connection refused (os error 111)",
    ),
  });
  const wrapped = wrapError("send request", raw);
  // The user gets an actionable reason, not the bare "fetch failed".
  assert(
    wrapped.message.includes("Connection refused (os error 111)"),
    wrapped.message,
  );
  // And the intermediate `fetch failed` framing is still present for classifiers
  // that key on it.
  assert(wrapped.message.includes("fetch failed"), wrapped.message);
});

Deno.test("wrapError does not repeat a reason the message already carries", () => {
  const inner = new Error("upstream stream read error");
  const outer = new Error("stream read error: upstream stream read error", {
    cause: inner,
  });
  const wrapped = wrapError("chat", outer);
  // The detail already appears in the top message, so it is appended once.
  assertEquals(
    wrapped.message.match(/upstream stream read error/g)?.length,
    1,
    wrapped.message,
  );
});

Deno.test("wrapError stringifies a non-Error thrown value", () => {
  assertEquals(
    wrapError("stage", "plain string").message,
    "stage: plain string",
  );
  assertEquals(wrapError("stage", 42).message, "stage: 42");
});

Deno.test("wrapError is idempotent over an already-wrapped chain", () => {
  const raw = new TypeError("fetch failed", {
    cause: new Error(
      "dns error: failed to lookup address: Name or service not known",
    ),
  });
  const once = wrapError("send request", raw);
  const twice = wrapError("stream read error", once);
  // The deeper reason is named once even though two wrappers were applied.
  assertEquals(
    twice.message.match(/failed to lookup address/g)?.length,
    1,
    twice.message,
  );
  // The full chain remains walkable to the classifier.
  assert(errorChainText(twice).includes("dns error"), errorChainText(twice));
  assertEquals(twice.cause, once);
  assertEquals(once.cause, raw);
});
