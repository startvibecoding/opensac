import { assertEquals } from "@opensac/assert";
import {
  ADDR_ENV,
  createDebugHandler,
  debugListenAddr,
  DEFAULT_ADDR,
  resetDebugServer,
  start,
} from "./debugendpoints.ts";

Deno.test("ServesExpvarsWithSQLiteStats", async () => {
  const req = new Request("http://127.0.0.1/debug/vars");
  const resp = createDebugHandler()(req);
  assertEquals(resp.status, 200);
  const vars = await resp.json();
  assertEquals(typeof vars["opensac_sqlite"], "object");
});

Deno.test("ListenAddrDefaultsToLocalhost", () => {
  const prev = Deno.env.get(ADDR_ENV);
  Deno.env.set(ADDR_ENV, "");
  try {
    assertEquals(debugListenAddr(), DEFAULT_ADDR);
  } finally {
    if (prev === undefined) Deno.env.delete(ADDR_ENV);
    else Deno.env.set(ADDR_ENV, prev);
  }
});

Deno.test("ListenAddrUsesEnvOverride", () => {
  const prev = Deno.env.get(ADDR_ENV);
  Deno.env.set(ADDR_ENV, "127.0.0.1:0");
  try {
    assertEquals(debugListenAddr(), "127.0.0.1:0");
  } finally {
    if (prev === undefined) Deno.env.delete(ADDR_ENV);
    else Deno.env.set(ADDR_ENV, prev);
  }
});

Deno.test("ServesPprofIndex", () => {
  const req = new Request("http://127.0.0.1/debug/pprof/");
  const resp = createDebugHandler()(req);
  assertEquals(resp.status, 200);
});

Deno.test("StartServesDebugServer", async () => {
  const prev = Deno.env.get(ADDR_ENV);
  Deno.env.set(ADDR_ENV, "127.0.0.1:0");
  resetDebugServer();
  try {
    const { addr, error } = start();
    if (error) throw error;
    const resp = await fetch(`http://${addr}/debug/pprof/`, {
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
  } finally {
    if (prev === undefined) Deno.env.delete(ADDR_ENV);
    else Deno.env.set(ADDR_ENV, prev);
  }
});
