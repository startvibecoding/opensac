import { assertEquals, assertNotEquals } from "../compat/assert.ts";
import { current, setVersion } from "./version.ts";
import { test } from "#testing";

test("CurrentUsesBuildVersion", () => {
  const prev = Deno.env.get("OPENSAC_BUILD_VERSION");
  setVersion("0.3.1");
  try {
    assertEquals(current(), "0.3.1");
  } finally {
    setVersion("");
    if (prev === undefined) Deno.env.delete("OPENSAC_BUILD_VERSION");
    else Deno.env.set("OPENSAC_BUILD_VERSION", prev);
  }
});

test("CurrentIsNeverEmpty", () => {
  setVersion("");
  Deno.env.delete("OPENSAC_BUILD_VERSION");
  Deno.env.delete("OPENSAC_VCS_REVISION");
  try {
    assertNotEquals(current(), "");
  } finally {
    // no-op
  }
});
