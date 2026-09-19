// Ported from internal/provider/http_client_test.go
//
// Deviation: Go asserts on *http.Transport internals (Proxy function,
// ForceAttemptHTTP2). Deno has no pluggable transport, so the port exposes the
// normalized proxy URL and HTTP/1.1 flag on the client and asserts on those.

import { assert, assertEquals } from "@std/assert";
import { newHttpClient, newHttpClientWithOptions } from "./mod.ts";

Deno.test("NewHTTPClientDefaultProxy", () => {
  const client = newHttpClient(1000, "");
  try {
    assertEquals(client.proxyUrl, undefined);
  } finally {
    client.close();
  }
});

Deno.test("NewHTTPClientExplicitProxy", () => {
  const client = newHttpClient(1000, " http://127.0.0.1:7890 ");
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
          newHttpClient(1000, proxyURL).close();
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
  const client = newHttpClientWithOptions(1000, { forceHTTP11: true });
  try {
    assertEquals(client.forceHTTP11, true);
  } finally {
    client.close();
  }
});
