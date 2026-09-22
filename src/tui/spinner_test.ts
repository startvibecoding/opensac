// Rotating-dot spinner frames: the pure tick → frame mapping.

import { assertEquals } from "@std/assert";
import { SPINNER_FRAMES, spinnerFrame } from "./spinner.ts";

Deno.test("spinnerFrame cycles through every frame and wraps", () => {
  for (let i = 0; i < SPINNER_FRAMES.length; i++) {
    assertEquals(spinnerFrame(i), SPINNER_FRAMES[i]);
  }
  assertEquals(spinnerFrame(SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
  assertEquals(spinnerFrame(-1), SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
});
