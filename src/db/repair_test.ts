import { assertEquals } from "@std/assert";
import {
  describeIndexRepair,
  recordIndexRepair,
  takeIndexRepairs,
} from "./mod.ts";

Deno.test("describeIndexRepair names the path and quotes the cause", () => {
  assertEquals(
    describeIndexRepair({
      path: "/data/sessions.db",
      cause: "database disk image is malformed",
      at: new Date("2026-01-01T00:00:00Z"),
    }),
    `rebuilt stale SQLite indexes in /data/sessions.db after an integrity check reported ${
      JSON.stringify("database disk image is malformed")
    }`,
  );
  assertEquals(
    describeIndexRepair({
      path: "/tmp/x.db",
      cause: "",
      at: new Date("0"),
    }),
    `rebuilt stale SQLite indexes in /tmp/x.db after an integrity check reported ""`,
  );
});

// TestTakeIndexRepairsDrainsOnce guards the "never silent, never twice"
// contract headless entry points rely on.
Deno.test("takeIndexRepairs drains the log exactly once", () => {
  takeIndexRepairs();

  recordIndexRepair({
    path: "/data/sessions.db",
    cause: "integrity check failed",
    at: new Date("2026-01-01T00:00:00Z"),
  });
  recordIndexRepair({
    path: "/data/other.db",
    cause: "integrity check failed",
    at: new Date("2026-01-01T00:00:01Z"),
  });

  const taken = takeIndexRepairs();
  assertEquals(
    taken.map((repair) => repair.path),
    ["/data/sessions.db", "/data/other.db"],
  );
  assertEquals(takeIndexRepairs(), [], "the log is empty after draining");
});
