// Ported from internal/version/version_test.go

import { assertEquals, assertNotEquals } from "@std/assert";
import { current, setVersion } from "./version.ts";

Deno.test("CurrentUsesBuildVersion", () => {
  const prev = Deno.env.get("MOTHX_BUILD_VERSION");
  setVersion("0.3.1");
  try {
    assertEquals(current(), "0.3.1");
  } finally {
    setVersion("");
    if (prev === undefined) Deno.env.delete("MOTHX_BUILD_VERSION");
    else Deno.env.set("MOTHX_BUILD_VERSION", prev);
  }
});

Deno.test("CurrentIsNeverEmpty", () => {
  setVersion("");
  Deno.env.delete("MOTHX_BUILD_VERSION");
  Deno.env.delete("MOTHX_VCS_REVISION");
  try {
    assertNotEquals(current(), "");
  } finally {
    // no-op
  }
});
