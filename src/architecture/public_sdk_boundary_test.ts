import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { publicSdkInternalImports } from "./guard.ts";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

// The public SDK (`sdk/agent`) is consumed by external modules and must never
// import this repository's `src/` packages. Implementation wiring belongs in
// `src/bootstrap/`, which external modules blank-import. The examples
// demonstrate correct public SDK usage and follow the same rule.
Deno.test("public SDK must not import src", () => {
  const violations = [
    ...publicSdkInternalImports(projectRoot, "sdk"),
    ...publicSdkInternalImports(projectRoot, "examples"),
  ];
  assertEquals(
    violations,
    [],
    `public SDK boundary violations (move wiring to src/bootstrap/):\n- ${
      violations.join("\n- ")
    }`,
  );
});
