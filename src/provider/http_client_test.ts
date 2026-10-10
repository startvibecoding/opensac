//
// Deviation: Go asserts on *http.Transport internals (Proxy function,
// ForceAttemptHTTP2). Node has no pluggable transport, so the port exposes the
// normalized proxy URL and HTTP/1.1 flag on the client and asserts on those.

import { assert, assertEquals } from "../compat/assert.ts";
import { createHttpClient } from "./mod.ts";
import { test } from "#testing";

test("NewHTTPClientDefaultProxy", () => {
  const client = createHttpClient(1000);
  try {
    assertEquals(client.proxyUrl, undefined);
  } finally {
    client.close();
  }
});

test("NewHTTPClientExplicitProxy", () => {
  const client = createHttpClient(1000, {
    proxyUrl: " http://127.0.0.1:7890 ",
  });
  try {
    assertEquals(client.proxyUrl, "http://127.0.0.1:7890");
  } finally {
    client.close();
  }
});

test("NewHTTPClientRejectsInvalidProxy", () => {
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

test("NewHTTPClientForceHTTP11", () => {
  const client = createHttpClient(1000, { forceHTTP11: true });
  try {
    assertEquals(client.forceHTTP11, true);
  } finally {
    client.close();
  }
});
