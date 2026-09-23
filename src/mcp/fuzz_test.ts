//
// Deno ships no built-in fuzzer, so the Go fuzz target becomes a deterministic
// property test over the same seeds plus generated inputs.

import { assert } from "@std/assert";
import { sanitizeToolName } from "./mcp.ts";

function* candidates(): Generator<string> {
  for (
    const seed of ["read_file", "MCP tool/1", "  ", "\x00name", "hello-world"]
  ) {
    yield seed;
  }
  const alphabet = "abcXYZ019 _-/.\x00\u4e2d";
  for (let i = 0; i < 500; i++) {
    let s = "";
    const len = i % 12;
    for (let j = 0; j < len; j++) {
      s += alphabet[(i * 7 + j * 13) % alphabet.length];
    }
    yield s;
  }
}

Deno.test("sanitizeToolName fuzz invariants", () => {
  for (const name of candidates()) {
    const got = sanitizeToolName(name);
    assert(got !== "", `SanitizeToolName(${JSON.stringify(name)}) was empty`);
    for (const r of got) {
      assert(
        /^[a-zA-Z0-9_]$/.test(r),
        `SanitizeToolName(${JSON.stringify(name)}) = ${
          JSON.stringify(got)
        } contains invalid character ${JSON.stringify(r)}`,
      );
    }
  }
});
