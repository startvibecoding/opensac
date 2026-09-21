// Translated from internal/serve/webhook/router_test.go.

import { assert, assertEquals } from "@std/assert";
import { createHmac } from "node:crypto";
import {
  type Handler,
  type RouteConfig,
  routeMatchesEvent,
  Router,
  verifySignature,
} from "./router.ts";

class MockHandler implements Handler {
  called = false;
  #deferred: Promise<void>;
  #resolve!: () => void;

  constructor() {
    this.#deferred = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  handleWebhookEvent(_route: RouteConfig, _payload: Uint8Array): void {
    this.called = true;
    this.#resolve();
  }

  /** Resolves once the fire-and-forget dispatch has landed, or fails after a grace period. */
  async waitCalled(): Promise<boolean> {
    const timeout = new Promise<boolean>((r) =>
      setTimeout(() => r(false), 500)
    );
    const landed = this.#deferred.then(() => true);
    return await Promise.race([landed, timeout]);
  }
}

function post(
  path: string,
  body: string | null,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:7872${path}`, {
    method: "POST",
    headers,
    body,
  });
}

Deno.test("newRouter", () => {
  const routes: RouteConfig[] = [
    {
      path: "/github",
      events: ["push", "pull_request"],
      skill: "code-review",
      delivery: "wechat",
    },
  ];
  const handler = new MockHandler();
  const router = new Router(routes, "secret123", handler);
  assert(router !== undefined, "expected router");
});

Deno.test("routerServeHTTPNoRoute", async () => {
  const handler = new MockHandler();
  const router = new Router([], "", handler);

  const res = await router.handler(post("/webhook/unknown", null));
  assertEquals(res.status, 404);
});

Deno.test("routerServeHTTPMethodNotAllowed", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["push"], skill: "", delivery: "" }],
    "",
    handler,
  );

  const res = await router.handler(
    new Request("http://127.0.0.1:7872/webhook/github"),
  );
  assertEquals(res.status, 405);
});

Deno.test("routerServeHTTPMatchRoute", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{
      path: "/github",
      events: ["push", "pull_request"],
      skill: "",
      delivery: "",
    }],
    "",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"action": "push"}`, { "X-GitHub-Event": "push" }),
  );
  assertEquals(res.status, 200);
  assert(await handler.waitCalled(), "expected handler to be called");
});

Deno.test("routerServeHTTPEventFilter", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["push"], skill: "", delivery: "" }],
    "",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"action": "issues"}`, {
      "X-GitHub-Event": "issues",
    }),
  );
  assertEquals(res.status, 200);
  assert(!handler.called, "expected handler NOT to be called (event filtered)");
});

Deno.test("routerServeHTTPWildcardEvent", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/ci", events: ["*"], skill: "", delivery: "" }],
    "",
    handler,
  );

  const res = await router.handler(post("/webhook/ci", `{"type": "build"}`));
  assertEquals(res.status, 200);
  assert(
    await handler.waitCalled(),
    "expected handler to be called (wildcard)",
  );
});

Deno.test("routerServeHTTPRejectsUnknownEventType", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["push"], skill: "", delivery: "" }],
    "",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"repository": {"name": "repo"}}`),
  );
  assertEquals(res.status, 200);
  const resp = await res.json();
  assertEquals(resp["status"], "skipped");
  assert(
    !(await handler.waitCalled()),
    "expected handler not to be called for unknown event type",
  );
});

Deno.test("routerSignatureVerification", async () => {
  const secret = "test-secret";
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["*"], skill: "", delivery: "" }],
    secret,
    handler,
  );

  const body = `{"action": "push"}`;
  const sig = "sha256=" +
    createHmac("sha256", secret).update(body).digest("hex");

  const res = await router.handler(
    post("/webhook/github", body, { "X-Hub-Signature-256": sig }),
  );
  assertEquals(res.status, 200);
  assert(
    await handler.waitCalled(),
    "expected handler to be called with valid signature",
  );
});

Deno.test("routerSignatureVerificationInvalid", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["*"], skill: "", delivery: "" }],
    "test-secret",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"action": "push"}`, {
      "X-Hub-Signature-256": "sha256=invalid",
    }),
  );
  assertEquals(res.status, 401);
  assert(
    !handler.called,
    "expected handler NOT to be called with invalid signature",
  );
});

Deno.test("routerSignatureVerificationMissing", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["*"], skill: "", delivery: "" }],
    "test-secret",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"action": "push"}`),
  );
  assertEquals(res.status, 401);
});

Deno.test("routerNoSecret", async () => {
  const handler = new MockHandler();
  const router = new Router(
    [{ path: "/github", events: ["*"], skill: "", delivery: "" }],
    "",
    handler,
  );

  const res = await router.handler(
    post("/webhook/github", `{"action": "push"}`),
  );
  assertEquals(res.status, 200);
  assert(
    await handler.waitCalled(),
    "expected handler to be called (no secret)",
  );
});

Deno.test("verifySignature", () => {
  const body = new TextEncoder().encode("hello");
  const validSig = "sha256=" +
    createHmac("sha256", "test").update(body).digest("hex");

  assert(verifySignature(body, validSig, "test"), "expected valid signature");
  assert(
    !verifySignature(body, "sha256=invalid", "test"),
    "expected invalid signature",
  );
  assert(
    !verifySignature(body, "", "test"),
    "expected empty signature to fail",
  );
});

Deno.test("routeMatchesEvent", () => {
  assert(routeMatchesEvent([], "anything"));
  assert(routeMatchesEvent(["*"], "anything"));
  assert(routeMatchesEvent(["push"], "push"));
  assert(!routeMatchesEvent(["push"], "issues"));
  assert(!routeMatchesEvent(["push"], ""));
});
