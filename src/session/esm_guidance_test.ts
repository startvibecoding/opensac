// Ported from internal/session/esm_guidance_test.go

import { assertEquals } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import {
  consumeESMGuidance,
  listESMGuidance,
  saveESMGuidance,
} from "./esm_guidance.ts";

Deno.test("ESM guidance lifecycle", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-esm-guidance-" });
  try {
    // Ensures the schema exists before querying.
    assertEquals(listESMGuidance(sessionDir, "missing", "pending", 10), []);

    saveESMGuidance(sessionDir, {
      id: "g-1",
      sessionId: "guidance-session",
      guidance: "run the focused tests",
      status: "",
      createdAt: new Date(0),
    });

    let items = listESMGuidance(
      sessionDir,
      "guidance-session",
      "pending",
      10,
    );
    assertEquals(items.length, 1);
    assertEquals(items[0].guidance, "run the focused tests");

    consumeESMGuidance(sessionDir, "guidance-session", ["g-1"]);
    items = listESMGuidance(sessionDir, "guidance-session", "consumed", 10);
    assertEquals(items.length, 1);
  } finally {
    closeAll();
  }
});
