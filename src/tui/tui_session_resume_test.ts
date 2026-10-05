// Regression tests for `-c` / `-r` startup resume and the reprint of a resumed
// session's durable conversation.
//
// The bug these pin: both flags were parsed and then dropped, so the TUI always
// opened a brand-new empty session. A continuation is only credible when the
// user can see the history being continued, so the reprint is asserted here as
// part of the same contract, not as an optional extra.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createFakeTUIService,
  type FakeTUIService,
  sessionNotResidentError,
} from "./service.ts";
import { isDirectoryTarget, TUISession } from "./tui_session.ts";

/** Redirects the config dir so no test touches real user state. */
function isolateConfigDir(): { restore: () => void } {
  const dir = Deno.makeTempDirSync();
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", dir);
  return {
    restore: () => {
      if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
      else Deno.env.set("OPENSAC_DIR", previous);
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Builds one TUISession over a shared fake service. */
function newSession(
  service: FakeTUIService,
  resume: {
    continueLast?: boolean;
    resumeSession?: string;
    workDir?: string;
    mode?: string;
  } = {},
): TUISession {
  return new TUISession(
    {
      provider: "test-provider",
      model: "test-model",
      mode: resume.mode ?? "yolo",
      thinking: "",
      workDir: resume.workDir ?? "/project",
      version: "test",
      continueLast: resume.continueLast,
      resumeSession: resume.resumeSession,
    },
    service,
  );
}

/** The non-empty transcript rows a session has rendered so far. */
function rows(session: TUISession): string[] {
  return session.controller.store.messages.filter((row) => row !== "");
}

Deno.test("continueLast resumes the newest persisted session and reprints it", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();

    // An older conversation in the same directory.
    const older = newSession(service);
    await older.start();
    const olderId = older.currentSessionID();
    service.seedTranscript(olderId, [
      { role: "user", text: "the older turn" },
    ]);
    await older.close();

    // A newer conversation: `-c` must continue this one.
    const newest = newSession(service);
    await newest.start();
    const newestId = newest.currentSessionID();
    service.seedTranscript(newestId, [
      { role: "user", text: "why is the build red" },
      { role: "assistant", text: "because fmt failed" },
    ]);
    await newest.close();

    const resumed = newSession(service, { continueLast: true });
    await resumed.start();

    assertEquals(
      resumed.currentSessionID(),
      newestId,
      "-c continues the newest session instead of opening a new one",
    );
    assert(
      resumed.currentSessionID() !== olderId,
      "-c must not pick an older session",
    );
    const rendered = rows(resumed).join("\n");
    assertStringIncludes(rendered, "> why is the build red");
    assertStringIncludes(rendered, "because fmt failed");
    assert(!rendered.includes("the older turn"), "only the continued session");
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("continueLast starts a fresh session when nothing is persisted yet", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const session = newSession(service, { continueLast: true });
    await session.start();
    assert(session.currentSessionID() !== "", "a session must still start");
    assertEquals(rows(session).length, 0, "a first run prints no history");
    await session.close();
  } finally {
    guard.restore();
  }
});

Deno.test("resumeSession wins over continueLast and reprints in order", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const first = newSession(service);
    await first.start();
    const firstId = first.currentSessionID();
    service.seedTranscript(firstId, [
      { role: "user", text: "first turn" },
      { role: "assistant", text: "first reply" },
      { role: "user", text: "second turn" },
    ]);
    await first.close();

    // A newer session exists, but an explicit -r target must be honoured.
    const later = newSession(service);
    await later.start();
    await later.close();

    const resumed = newSession(service, {
      continueLast: true,
      resumeSession: firstId,
    });
    await resumed.start();

    assertEquals(resumed.currentSessionID(), firstId);
    const rendered = rows(resumed);
    assertEquals(
      rendered.filter((row) => row.startsWith("> ")).length,
      2,
      "both user turns reprint",
    );
    assertEquals(
      rendered.slice(0, 3),
      [
        "> first turn",
        `${
          resumed.translator.text("transcript.assistant_prefix")
        }\nfirst reply`,
        "> second turn",
      ],
      "history reprints in its original order through the normal rows",
    );
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("an unresolvable resume target reports once and still starts a usable session", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const session = newSession(service, { resumeSession: "missing-session" });
    await session.start();

    assert(session.currentSessionID() !== "", "a session must still start");
    assertStringIncludes(rows(session).join("\n"), "missing-session");
    // The failed resume is reported once; the fresh session stays usable.
    const accepted = await service.prompt({
      sessionId: session.currentSessionID(),
      text: "hello after failed resume",
    });
    assertEquals(accepted.status, "running");
    await session.close();
  } finally {
    guard.restore();
  }
});

Deno.test("a transcript read failure keeps the resumed session usable", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const first = newSession(service);
    await first.start();
    const id = first.currentSessionID();
    service.seedTranscript(id, [{ role: "user", text: "remember me" }]);
    await first.close();

    // Stand in for a Core that can open the session but cannot project it.
    const original = service.getTranscript;
    service.getTranscript = () =>
      Promise.reject(new Error("transcript unavailable"));

    const resumed = newSession(service, { resumeSession: id });
    await resumed.start();

    assertEquals(
      resumed.currentSessionID(),
      id,
      "the session is still adopted",
    );
    assertStringIncludes(
      rows(resumed).join("\n"),
      "transcript unavailable",
      "the missing reprint is disclosed rather than silent",
    );
    service.getTranscript = original;
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("isDirectoryTarget separates a path from a session id", () => {
  // A bare token is an id: that is what `opensac -r abc123` means.
  assertEquals(isDirectoryTarget("abc123"), false);
  assertEquals(isDirectoryTarget(""), false);
  // Any separator makes it a path, on either platform's spelling.
  assertEquals(isDirectoryTarget("/var/tmp/project"), true);
  assertEquals(isDirectoryTarget("./"), true);
  assertEquals(isDirectoryTarget(".."), true);
  assertEquals(isDirectoryTarget("~/code/app"), true);
  assertEquals(isDirectoryTarget("C:\\Users\\me\\app"), true);
});

Deno.test("a resume target in another directory is not adopted", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    // The session belongs to a different project than the one we start in.
    const foreign = newSession(service, { workDir: "/other" });
    await foreign.start();
    const foreignId = foreign.currentSessionID();
    service.seedTranscript(foreignId, [{ role: "user", text: "elsewhere" }]);
    await foreign.close();

    const here = newSession(service, { resumeSession: foreignId });
    await here.start();

    assert(
      here.currentSessionID() !== foreignId,
      "a session of another directory must not be adopted under this cwd",
    );
    assertStringIncludes(rows(here).join("\n"), foreignId);
    await here.close();
  } finally {
    guard.restore();
  }
});

Deno.test("a Core failure during resume propagates instead of reporting a bad id", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    // Stand in for an unreachable Core: not a missing session.
    service.openSession = () =>
      Promise.reject(new Error("core connection lost"));
    const session = newSession(service, { resumeSession: "session-9" });
    await assertRejects(() => session.start(), Error, "core connection lost");
  } finally {
    guard.restore();
  }
});

Deno.test("-c with no session in the directory ignores other directories", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const elsewhere = newSession(service, { workDir: "/other" });
    await elsewhere.start();
    await elsewhere.close();

    // Nothing was ever recorded for /project, so `-c` starts fresh rather than
    // continuing an unrelated directory's conversation.
    const session = newSession(service, {
      continueLast: true,
    });
    await session.start();
    assertEquals(rows(session).length, 0, "no history reprinted");
    assert(session.currentSessionID() !== elsewhere.currentSessionID());
    await session.close();
  } finally {
    guard.restore();
  }
});

Deno.test("a resume scopes its open to the directory the target came from", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    // The shared Core's startup directory is not the front end's cwd, so an
    // unscoped open would resolve against a directory that holds no session.
    const first = newSession(service, { workDir: "/project" });
    await first.start();
    const id = first.currentSessionID();
    service.seedTranscript(id, [{ role: "user", text: "keep me" }]);
    await first.close();

    const calls: Array<{ sessionId: string; workDir?: string }> = [];
    const original = service.openSession;
    service.openSession = (input) => {
      calls.push({ ...input });
      return original(input);
    };

    const resumed = newSession(service, {
      continueLast: true,
      workDir: "/project",
    });
    await resumed.start();

    assertEquals(resumed.currentSessionID(), id, "-c still resumes");
    assert(
      calls.some((c) => c.workDir === "/project"),
      `the resume open must carry its work directory, got ${
        JSON.stringify(calls)
      }`,
    );
    service.openSession = original;
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("a resumed session inherits its persisted mode", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const first = newSession(service, { mode: "plan" });
    await first.start();
    const id = first.currentSessionID();
    await first.close();

    // No explicit --mode: the persisted session mode must win, exactly as the
    // `/sessions` switch path applies it, or `-r` silently downgrades a plan
    // session to the product default on its first prompt.
    const resumed = newSession(service, { mode: "", resumeSession: id });
    await resumed.start();
    assertEquals(resumed.mode, "plan", "the persisted mode survives -r");
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("repeated resume reprints the history once, not twice", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    const first = newSession(service);
    await first.start();
    const id = first.currentSessionID();
    service.seedTranscript(id, [{ role: "user", text: "only once" }]);
    await first.close();

    const resumed = newSession(service, { resumeSession: id });
    await resumed.start();
    // A second resume of the same session (switch away and back) replaces the
    // reprint rather than appending a duplicate copy of it.
    await resumed.resumePersistedSession(id);

    const rendered = rows(resumed);
    assertEquals(
      rendered.filter((row) => row === "> only once").length,
      1,
      `history must reprint once, got ${JSON.stringify(rendered)}`,
    );
    await resumed.close();
  } finally {
    guard.restore();
  }
});

Deno.test("a not-resident Core answer is retried, not reported as a bad id", async () => {
  const guard = isolateConfigDir();
  try {
    const service = createFakeTUIService();
    // A real row, so the resumed session is a genuine persisted identity that
    // the standard teardown can close.
    const seeded = await service.createSession({ workDir: "/project" });
    const id = seeded.sessionId;
    // Stand in for a Core restart: the first open answers "persisted but not
    // resident", using the dedicated protocol code over a message that is
    // deliberately identical to a missing-session text.
    const original = service.openSession;
    let attempts = 0;
    service.openSession = (input) => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(sessionNotResidentError(input.sessionId));
      }
      return original(input);
    };
    const session = newSession(service, { resumeSession: id });
    await session.start();
    try {
      assertEquals(
        attempts,
        2,
        "a not-resident answer must re-open rather than conclude the id is bad",
      );
      assertEquals(session.currentSessionID(), id);
      assert(
        !rows(session).some((row) =>
          row.includes("resume_failed") ||
          row.includes("Cannot resume")
        ),
        "a Core restart must not be reported as an unresumable session",
      );
    } finally {
      service.openSession = original;
    }
  } finally {
    guard.restore();
  }
});
