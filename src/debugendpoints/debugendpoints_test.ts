import { runtime } from "../platform/runtime.ts";
import { assertEquals } from "../compat/assert.ts";
import {
  ADDR_ENV,
  createDebugHandler,
  debugListenAddr,
  DEFAULT_ADDR,
  resetDebugServer,
  start,
} from "./debugendpoints.ts";
import { test } from "#testing";

test("ServesExpvarsWithSQLiteStats", async () => {
  const req = new Request("http://127.0.0.1/debug/vars");
  const resp = createDebugHandler()(req);
  assertEquals(resp.status, 200);
  const vars = await resp.json();
  assertEquals(typeof vars["opensac_sqlite"], "object");
});

test("ListenAddrDefaultsToLocalhost", () => {
  const prev = runtime.env.get(ADDR_ENV);
  runtime.env.set(ADDR_ENV, "");
  try {
    assertEquals(debugListenAddr(), DEFAULT_ADDR);
  } finally {
    if (prev === undefined) runtime.env.delete(ADDR_ENV);
    else runtime.env.set(ADDR_ENV, prev);
  }
});

test("ListenAddrUsesEnvOverride", () => {
  const prev = runtime.env.get(ADDR_ENV);
  runtime.env.set(ADDR_ENV, "127.0.0.1:0");
  try {
    assertEquals(debugListenAddr(), "127.0.0.1:0");
  } finally {
    if (prev === undefined) runtime.env.delete(ADDR_ENV);
    else runtime.env.set(ADDR_ENV, prev);
  }
});

test("ServesPprofIndex", () => {
  const req = new Request("http://127.0.0.1/debug/pprof/");
  const resp = createDebugHandler()(req);
  assertEquals(resp.status, 200);
});

test("StartServesDebugServer", async () => {
  const prev = runtime.env.get(ADDR_ENV);
  runtime.env.set(ADDR_ENV, "127.0.0.1:0");
  resetDebugServer();
  try {
    const { addr, error } = await start();
    if (error) throw error;
    const resp = await fetch(`http://${addr}/debug/pprof/`, {
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
  } finally {
    if (prev === undefined) runtime.env.delete(ADDR_ENV);
    else runtime.env.set(ADDR_ENV, prev);
  }
});
