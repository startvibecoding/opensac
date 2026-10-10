// (the large-file streaming case)
// plus focused extras for the bash timeout and registry sandbox.

import { assert, assertEquals, assertStringIncludes } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { BashTool, createRegistry, InsertTool } from "./mod.ts";
import { createJobManager } from "./jobmanager.ts";
import { createBashTool } from "./bash.ts";
import { test } from "#testing";

const insertInMemoryLimit = 32 * 1024 * 1024;

test("InsertTool streams a large file insertion", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = path.join(dir, "large.txt");
    const data = new Uint8Array(insertInMemoryLimit + 1);
    data.fill("a".charCodeAt(0));
    Deno.writeFileSync(file, data);

    const tool = new InsertTool(createRegistry(dir, undefined));
    const r = await tool.execute(
      {},
      { path: "large.txt", content: "tail", position: { type: "tail" } },
    );
    assert(r.insert);
    assertEquals(r.insert.offset, data.length);
    const got = Deno.readFileSync(file);
    assertEquals(got.length, data.length + "\ntail".length);
    assert(
      new TextDecoder().decode(got.subarray(got.length - 5)) === "\ntail",
    );
  } finally {
    // This test writes a file larger than the insert in-memory limit, so
    // leaving it behind leaked >32MB into the temp dir on every run and could
    // fill a tmpfs mount outright.
    Deno.removeSync(dir, { recursive: true });
  }
});

test("BashTool applies a sync timeout", async () => {
  const tool = new BashTool(
    createRegistry("/tmp", undefined),
    createJobManager(),
  );
  const start = Date.now();
  const result = await tool.execute({}, {
    command: "sleep 5",
    timeout: 1,
  });
  assert(Date.now() - start < 4000, "timeout should abort the command");
  assertStringIncludes(result.text, "[exit_code]\n");
});

test("BashTool executes an & command asynchronously", async () => {
  const jm = createJobManager();
  const bash = createBashTool(
    createRegistry("/tmp", undefined),
    jm,
  );
  const result = await bash.execute({}, { command: "sleep 5 &" });
  assertStringIncludes(result.text, "Use 'jobs' tool to check status");
  assertEquals(jm.listJobs().length, 1);
  jm.killJob(1);
});
