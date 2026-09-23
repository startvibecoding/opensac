// (the large-file streaming case)
// plus focused extras for the bash timeout and registry sandbox.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { BashTool, InsertTool, newRegistry } from "./mod.ts";
import { newJobManager } from "./jobmanager.ts";
import { newBashToolWithJobManager } from "./bash.ts";

const insertInMemoryLimit = 32 * 1024 * 1024;

Deno.test("InsertTool streams a large file insertion", async () => {
  const dir = Deno.makeTempDirSync();
  const file = path.join(dir, "large.txt");
  const data = new Uint8Array(insertInMemoryLimit + 1);
  data.fill("a".charCodeAt(0));
  Deno.writeFileSync(file, data);

  const tool = new InsertTool(newRegistry(dir, undefined));
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
});

Deno.test("BashTool applies a sync timeout", async () => {
  const tool = new BashTool(newRegistry("/tmp", undefined), newJobManager());
  const start = Date.now();
  const result = await tool.execute({}, {
    command: "sleep 5",
    timeout: 1,
  });
  assert(Date.now() - start < 4000, "timeout should abort the command");
  assertStringIncludes(result.text, "[exit_code]\n");
});

Deno.test("BashTool executes an & command asynchronously", async () => {
  const jm = newJobManager();
  const bash = newBashToolWithJobManager(newRegistry("/tmp", undefined), jm);
  const result = await bash.execute({}, { command: "sleep 5 &" });
  assertStringIncludes(result.text, "Use 'jobs' tool to check status");
  assertEquals(jm.listJobs().length, 1);
  jm.killJob(1);
});
