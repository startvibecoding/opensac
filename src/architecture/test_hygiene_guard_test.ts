import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { legacyTestAllowlist, legacyTestBoundaryViolations } from "./guard.ts";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

// Freezes the test-hygiene debt. Production code is already barred from the
// legacy session run/lease APIs and from `new Agent` (see
// architecture_guard_test.ts), but that guard skips `_test.ts`, so adapter
// tests can still seed canonical run/lease state by hand. Those fixtures can
// drift from the real Runtime lifecycle. New occurrences are rejected unless
// the file is listed in `legacyTestAllowlist` with a reason. Owner packages
// (`src/agentruntime`, `src/session`, `src/dao`, `src/db`, `src/agent`) and the
// guard itself are exempt: they test the APIs they own.
Deno.test("adapter tests use canonical run boundaries", () => {
  const violations = legacyTestBoundaryViolations(projectRoot);
  assertEquals(
    violations,
    [],
    `adapter tests must use the canonical runtime boundaries (migrate, or add a documented legacyTestAllowlist entry):\n- ${
      violations.map((v) => `${v.file}: ${v.message}`).join("\n- ")
    }\n\nallowlist (${Object.keys(legacyTestAllowlist).length} entries):\n\t${
      Object.keys(legacyTestAllowlist).sort().join("\n\t")
    }`,
  );
});
