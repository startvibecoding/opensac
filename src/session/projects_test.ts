// Ported from internal/session/phase1_projections_test.go (project and session
// metadata sections; Manager-based setup replaced with a bare schema).

import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import {
  createProject,
  deleteProject,
  getSessionMetadata,
  listProjects,
  listSessionMetadata,
  projectSessionCounts,
  renameProject,
  setSessionMetadata,
} from "./projects.ts";

Deno.test("list session metadata batch and project counts", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-session-" });
  try {
    const project = createProject(sessionDir, "Phase1");
    assert(project.id !== "");
    setSessionMetadata(sessionDir, "session-meta-a", {
      projectId: project.id,
      pinned: true,
    });
    setSessionMetadata(sessionDir, "session-meta-b", { pinned: true });

    const metadata = listSessionMetadata(sessionDir, [
      "session-meta-a",
      "session-meta-b",
      "session-missing",
    ]);
    assertEquals(metadata.size, 2);
    assertEquals(metadata.get("session-meta-a")?.projectId, project.id);
    assertEquals(metadata.get("session-meta-a")?.pinned, true);
    assertFalseNaN(metadata.get("session-meta-a")?.updatedAt?.getTime());
    assert(!metadata.has("session-missing"));

    const counts = projectSessionCounts(sessionDir);
    assertEquals(counts.get(project.id), 1);

    const single = getSessionMetadata(sessionDir, "session-meta-a");
    assertFalseNaN(single.updatedAt?.getTime());
    assertEquals(single.projectId, project.id);
    assertEquals(single.pinned, true);

    // Renaming updates the persisted name and preserves the ID.
    const renamed = renameProject(sessionDir, project.id, "Phase1-renamed");
    assertEquals(renamed.name, "Phase1-renamed");
    assertEquals(listProjects(sessionDir)[0].name, "Phase1-renamed");
  } finally {
    closeAll();
  }
});

Deno.test("delete project clears session assignments but keeps the pin", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-session-" });
  try {
    const project = createProject(sessionDir, "Temporary");
    setSessionMetadata(sessionDir, "session-project-delete", {
      projectId: project.id,
      pinned: true,
    });
    deleteProject(sessionDir, project.id);

    assertEquals(listProjects(sessionDir).length, 0);
    const metadata = getSessionMetadata(sessionDir, "session-project-delete");
    // ON DELETE SET NULL semantics hold even without SQLite foreign-key
    // enforcement: the assignment is cleared, the pin survives.
    assertEquals(metadata.projectId, undefined);
    assertEquals(metadata.pinned, true);
  } finally {
    closeAll();
  }
});

Deno.test("list projects degrades on a missing database", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-session-" });
  try {
    assertEquals(listProjects(sessionDir), []);
  } finally {
    closeAll();
  }
});

function assertFalseNaN(value: number | undefined): void {
  assert(
    value !== undefined && !Number.isNaN(value),
    "expected a parsed timestamp",
  );
}
