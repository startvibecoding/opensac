import { assert, assertEquals } from "@opensac/assert";
import { resourceUrl } from "./resources.ts";

Deno.test("resourceUrl resolves the source layout", () => {
  assertEquals(
    resourceUrl("stats/dashboard.html"),
    new URL("../../src/stats/dashboard.html", import.meta.url),
  );
});

Deno.test("resourceUrl recognizes an installed package layout", () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync());
  try {
    const binDir = `${dir}/bin`;
    Deno.mkdirSync(binDir, { recursive: true });
    Deno.writeTextFileSync(`${dir}/package.json`, "{}");
    Deno.copyFileSync(
      new URL("./resources.ts", import.meta.url),
      `${binDir}/resources.ts`,
    );
    Deno.writeTextFileSync(
      `${binDir}/probe.ts`,
      'import { resourceUrl } from "./resources.ts";\nconsole.log(resourceUrl("stats/dashboard.html").href);\n',
    );
    const output = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `${binDir}/probe.ts`],
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
    Deno.removeSync(dir, { recursive: true });
  }
});
