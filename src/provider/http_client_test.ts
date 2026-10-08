//
// Deviation: Go asserts on *http.Transport internals (Proxy function,
// ForceAttemptHTTP2). Deno has no pluggable transport, so the port exposes the
// normalized proxy URL and HTTP/1.1 flag on the client and asserts on those.

import { assert, assertEquals } from "@opensac/assert";
import { createHttpClient } from "./mod.ts";

Deno.test("NewHTTPClientDefaultProxy", () => {
  const client = createHttpClient(1000);
  try {
    assertEquals(client.proxyUrl, undefined);
  } finally {
    client.close();
  }
});

Deno.test("NewHTTPClientExplicitProxy", () => {
  const client = createHttpClient(1000, {
    proxyUrl: " http://127.0.0.1:7890 ",
  });
  try {
    assertEquals(client.proxyUrl, "http://127.0.0.1:7890");
  } finally {
    client.close();
  }
});

Deno.test("NewHTTPClientRejectsInvalidProxy", () => {
  for (const proxyURL of ["http://[::1", "127.0.0.1:7890", "http://"]) {
    assert(
      (() => {
        try {
          createHttpClient(1000, { proxyUrl: proxyURL }).close();
          return false;
        } catch {
          return true;
        }
      })(),
      proxyURL,
    );
  }
});

Deno.test("NewHTTPClientForceHTTP11", () => {
  const client = createHttpClient(1000, { forceHTTP11: true });
  try {
    assertEquals(client.forceHTTP11, true);
  } finally {
    client.close();
  }
});
