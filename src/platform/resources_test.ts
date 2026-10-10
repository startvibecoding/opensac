import * as runtime from "./runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { resourceUrl } from "./resources.ts";
import { test } from "#testing";

test("resourceUrl resolves the source layout", () => {
  assertEquals(
    resourceUrl("stats/dashboard.html"),
    new URL("../../src/stats/dashboard.html", import.meta.url),
  );
});

test("resourceUrl resolves every bundled resource in the source layout", () => {
  // The DeepSeek tokenizer, the stats assets, and the BusyBox binaries each
  // live under a different src/ subtree. A regression that resolves one level
  // too high silently disabled every estimate and asset (the tokenizer load
  // failure is swallowed), so each bundled family must stat here.
  for (const rel of [
    "context/tokenizerdata/deepseek_v3_tokenizer.json",
    "stats/dashboard.html",
    "stats/opensac.png",
    "platform/busybox_assets/busybox64u.exe",
  ]) {
    const url = resourceUrl(rel);
    assert(runtime.statSync(url).size > 0, `missing resource: ${url.href}`);
  }
});

test("resourceUrl recognizes an installed package layout", () => {
  const dir = runtime.realPathSync(runtime.makeTempDirSync());
  try {
    const binDir = `${dir}/bin`;
    runtime.mkdirSync(binDir, { recursive: true });
    runtime.writeTextFileSync(`${dir}/package.json`, "{}");
    runtime.copyFileSync(
      new URL("./resources.ts", import.meta.url),
      `${binDir}/resources.ts`,
    );
    runtime.writeTextFileSync(
      `${binDir}/probe.ts`,
      'import { resourceUrl } from "./resources.ts";\nconsole.log(resourceUrl("stats/dashboard.html").href);\n',
    );
    const output = new runtime.Command(runtime.execPath(), {
      args: [`${binDir}/probe.ts`],
      cwd: binDir,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assert(output.success, new TextDecoder().decode(output.stderr));
    assertEquals(
      new TextDecoder().decode(output.stdout).trim(),
      `file://${dir}/stats/dashboard.html`,
    );
  } finally {
    runtime.removeSync(dir, { recursive: true });
  }
});
