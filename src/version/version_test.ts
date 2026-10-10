import { runtime } from "../platform/runtime.ts";
import { assertEquals, assertNotEquals } from "../compat/assert.ts";
import { current, setVersion } from "./version.ts";
import { test } from "#testing";

test("CurrentUsesBuildVersion", () => {
  const prev = runtime.env.get("OPENSAC_BUILD_VERSION");
  setVersion("0.3.1");
  try {
    assertEquals(current(), "0.3.1");
  } finally {
    setVersion("");
    if (prev === undefined) runtime.env.delete("OPENSAC_BUILD_VERSION");
    else runtime.env.set("OPENSAC_BUILD_VERSION", prev);
  }
});

test("CurrentIsNeverEmpty", () => {
  setVersion("");
  runtime.env.delete("OPENSAC_BUILD_VERSION");
  runtime.env.delete("OPENSAC_VCS_REVISION");
  try {
    assertNotEquals(current(), "");
  } finally {
    // no-op
  }
});
