//
// Deviation: Go's fallback test relies on json.Marshal rejecting a malformed
// json.RawMessage. JSON.stringify does not reject arbitrary strings, so the
// fallback path is exercised here with a BigInt argument (which JSON.stringify
// cannot serialize), preserving the same fallback contract.

import { assert } from "@opensac/assert";
import {
  debugCompleteResponse,
  debugJSON,
  debugLogf,
  debugLogOnlyEnv,
} from "./mod.ts";

async function inTempDir(fn: () => void | Promise<void>): Promise<void> {
  const workDir = await Deno.makeTempDir();
  const old = Deno.cwd();
  Deno.chdir(workDir);
  try {
    await fn();
  } finally {
    Deno.chdir(old);
  }
}

async function readLog(workDir: string): Promise<string> {
  return await Deno.readTextFile(`${workDir}/debug.log`);
}

Deno.test("DebugJSONWritesRequestAndCompleteResponse", async () => {
  Deno.env.set("VIBECODING_DEBUG", "1");
  Deno.env.set(debugLogOnlyEnv, "1");
  try {
    await inTempDir(async () => {
      debugJSON("OpenAI request JSON", `{"model":"test","stream":true}`);
      debugCompleteResponse({
        provider: "openai",
        api: "chat-completions",
        content: "complete response",
      });

      const log = await readLog(Deno.cwd());
      assert(
        log.includes(`OpenAI request JSON: {"model":"test","stream":true}`),
        `debug log missing request JSON: ${log}`,
      );
      assert(
        log.includes(
          `Response JSON: {"provider":"openai","api":"chat-completions","content":"complete response"}`,
        ),
        `debug log missing complete response JSON: ${log}`,
      );
      assert(
        !log.includes("data:"),
        `debug log contains an SSE fragment: ${log}`,
      );
    });
  } finally {
    Deno.env.delete("VIBECODING_DEBUG");
    Deno.env.delete(debugLogOnlyEnv);
  }
});

Deno.test("DebugLogfWritesOnlyWhenDebugEnabled", async () => {
  await inTempDir(async () => {
    Deno.env.set(debugLogOnlyEnv, "1");
    Deno.env.delete("VIBECODING_DEBUG");
    try {
      debugLogf("not written");
      let exists = true;
      try {
        await Deno.stat(`${Deno.cwd()}/debug.log`);
      } catch {
        exists = false;
      }
      assert(!exists, "debug log exists without debug mode");

      Deno.env.set("VIBECODING_DEBUG", "1");
      debugLogf(
        "session %q sync failed: %v",
        "s1",
        new Error("file does not exist"),
      );
      const data = await readLog(Deno.cwd());
      assert(
        data.includes(`diagnostic: session "s1" sync failed`),
        `debug log missing diagnostic: ${data}`,
      );
    } finally {
      Deno.env.delete("VIBECODING_DEBUG");
      Deno.env.delete(debugLogOnlyEnv);
    }
  });
});

Deno.test("DebugCompleteResponseLogsResponseWhenJSONMarshalFails", async () => {
  Deno.env.set("VIBECODING_DEBUG", "1");
  Deno.env.set(debugLogOnlyEnv, "1");
  try {
    await inTempDir(async () => {
      debugCompleteResponse({
        provider: "openai",
        api: "chat-completions",
        toolCalls: [{
          id: "call_1",
          name: "read_file",
          arguments: 123n as unknown,
        }],
      });

      const log = await readLog(Deno.cwd());
      assert(
        log.includes("Response JSON marshal error"),
        `missing marshal error: ${log}`,
      );
      assert(
        log.includes("call_1"),
        `missing unmarshalable response content: ${log}`,
      );
      assert(log.includes("123"), `missing argument dump: ${log}`);
    });
  } finally {
    Deno.env.delete("VIBECODING_DEBUG");
    Deno.env.delete(debugLogOnlyEnv);
  }
});
