import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  buildNpmPackages,
  INSTALLER_NAME,
  normalizeScope,
  optionalDependencies,
  platformMapModule,
  platformPackageJson,
  scopedName,
  toPackageVersion,
} from "./build_npm_packages.ts";
import { findPlatform, PLATFORM_TARGETS } from "./platforms.ts";

/** Wrapper sources copied into the entry package, by their source names. */
const WRAPPER_SOURCE = "npm_installer_wrapper.js";
const POSTINSTALL_SOURCE = "npm_postinstall.js";

/** Creates a temp repo with a fake `npm/package.json` and a `bin/` binary. */
async function makeRepo(
  binaries: readonly string[],
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "opensac-npm-test-" });
  await Deno.mkdir(join(dir, "bin"), { recursive: true });
  await Deno.mkdir(join(dir, "npm"), { recursive: true });
  // The packager copies the real wrapper sources out of scripts/.
  await Deno.mkdir(join(dir, "scripts"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "scripts", WRAPPER_SOURCE),
    "#!/usr/bin/env node\n",
  );
  await Deno.writeTextFile(
    join(dir, "scripts", POSTINSTALL_SOURCE),
    "// banner\n",
  );
  await Deno.writeTextFile(
    join(dir, "npm", "package.json"),
    `${
      JSON.stringify(
        {
          name: INSTALLER_NAME,
          version: "0.0.0",
          bin: { opensac: "bin/opensac" },
        },
        null,
        2,
      )
    }\n`,
  );
  await Deno.writeTextFile(join(dir, "npm", "README.md"), "# opensac\n");
  for (const binary of binaries) {
    await Deno.writeTextFile(join(dir, "bin", binary), "binary");
  }
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

/** Absolute path of the real npm wrapper source in this repository. */
function realWrapperSource(): string {
  return join(import.meta.dirname ?? ".", WRAPPER_SOURCE);
}

/** Whether `node` can run, so the wrapper test can execute the real script. */
async function hasNode(): Promise<boolean> {
  try {
    const status = await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).spawn().status;
    return status.success;
  } catch {
    return false;
  }
}

Deno.test("ToPackageVersionStripsTheVPrefixAndDirtySuffix", () => {
  assertEquals(toPackageVersion("v1.2.3"), "1.2.3");
  assertEquals(toPackageVersion("v1.2.3-dirty"), "1.2.3");
  assertEquals(toPackageVersion("0.1.0"), "0.1.0");
  assertEquals(toPackageVersion("  v2.0.0  "), "2.0.0");
  assertEquals(toPackageVersion(""), "");
});

Deno.test("PlatformPackageJsonCarriesTheNpmSelectionFields", () => {
  const target = findPlatform("darwin-arm64");
  if (target === undefined) throw new Error("darwin-arm64 must be a platform");
  const pkg = platformPackageJson(target, "1.2.3");
  assertEquals(pkg.name, "opensac-installer-darwin-arm64");
  assertEquals(pkg.version, "1.2.3");
  assertEquals(pkg.os, ["darwin"]);
  assertEquals(pkg.cpu, ["arm64"]);
  assertEquals(pkg.files, ["bin/"]);
});

Deno.test("OptionalDependenciesCoverOnlyTheGivenPlatforms", () => {
  const linux = PLATFORM_TARGETS.filter((t) => t.os === "linux");
  const deps = optionalDependencies(linux, "3.0.0");
  assertEquals(Object.keys(deps).sort(), [
    "opensac-installer-linux-arm64",
    "opensac-installer-linux-x64",
  ]);
  assertEquals(deps["opensac-installer-linux-x64"], "3.0.0");
});

Deno.test("NormalizeScopeAcceptsBothFormsAndRejectsGarbage", () => {
  assertEquals(normalizeScope(""), "");
  assertEquals(normalizeScope(undefined), "");
  assertEquals(normalizeScope("owner"), "@owner");
  assertEquals(normalizeScope("@owner"), "@owner");
  assertEquals(normalizeScope("  @owner  "), "@owner");
  assertEquals(
    scopedName("opensac-installer", "@owner"),
    "@owner/opensac-installer",
  );
  assertEquals(scopedName("opensac-installer"), "opensac-installer");
  assertThrows(() => normalizeScope("@"), Error);
  assertThrows(() => normalizeScope("@own er"), Error);
});

Deno.test("ScopedPlatformPackageJsonCarriesTheScope", () => {
  const target = findPlatform("linux-x64");
  if (target === undefined) throw new Error("linux-x64 must be a platform");
  const pkg = platformPackageJson(target, "1.2.3", "owner");
  assertEquals(pkg.name, "@owner/opensac-installer-linux-x64");
  assertEquals(pkg.os, ["linux"]);
});

Deno.test("OptionalDependenciesCarryTheScope", () => {
  const linux = PLATFORM_TARGETS.filter((t) => t.os === "linux");
  const deps = optionalDependencies(linux, "3.0.0", "@owner");
  assertEquals(Object.keys(deps).sort(), [
    "@owner/opensac-installer-linux-arm64",
    "@owner/opensac-installer-linux-x64",
  ]);
  // The generated map is what the published wrapper requires, so it has to use
  // the same scoped names or a GitHub Packages install resolves nothing.
  const map = platformMapModule("@owner");
  assertEquals(
    map.includes('"linux-x64": "@owner/opensac-installer-linux-x64",'),
    true,
  );
});

Deno.test("BuildNpmPackagesWritesAScopedTreeBesideTheTrackedOne", async () => {
  const { dir, cleanup } = await makeRepo([
    "opensac-linux-amd64",
    "opensac-darwin-arm64",
  ]);
  try {
    const outDir = join(dir, "dist", "npm-github");
    const built = await buildNpmPackages(dir, "2.0.0", {
      npmDir: outDir,
      scope: "@owner",
    });
    assertEquals(built.map((t) => t.npmPlatform), [
      "linux-x64",
      "darwin-arm64",
    ]);

    const platform = JSON.parse(
      await Deno.readTextFile(
        join(outDir, "packages", "opensac-installer-linux-x64", "package.json"),
      ),
    );
    assertEquals(platform.name, "@owner/opensac-installer-linux-x64");
    assertEquals(platform.version, "2.0.0");
    assertEquals(
      await Deno.readTextFile(
        join(
          outDir,
          "packages",
          "opensac-installer-linux-x64",
          "bin",
          "opensac",
        ),
      ),
      "binary",
    );

    const entry = JSON.parse(
      await Deno.readTextFile(join(outDir, "package.json")),
    );
    assertEquals(entry.name, "@owner/opensac-installer");
    assertEquals(entry.version, "2.0.0");
    assertEquals(Object.keys(entry.optionalDependencies).sort(), [
      "@owner/opensac-installer-darwin-arm64",
      "@owner/opensac-installer-linux-x64",
    ]);
    // The entry template still supplies the non-release-specific fields.
    assertEquals(entry.bin, { opensac: "bin/opensac" });
    // The manifest's `files` lists a README, so the generated tree needs one.
    assertEquals(
      await Deno.readTextFile(join(outDir, "README.md")),
      "# opensac\n",
    );

    // The tracked npmjs manifest must be untouched by a scoped build.
    const tracked = JSON.parse(
      await Deno.readTextFile(join(dir, "npm", "package.json")),
    );
    assertEquals(tracked.name, INSTALLER_NAME);
    assertEquals(tracked.version, "0.0.0");
    assertEquals(tracked.optionalDependencies, undefined);
  } finally {
    await cleanup();
  }
});

Deno.test("TheWrapperReinstallHintNamesThePackageItCameFrom", async () => {
  if (!await hasNode()) {
    console.log("node is unavailable; skipping the wrapper execution test");
    return;
  }
  const dir = await Deno.makeTempDir({ prefix: "opensac-wrapper-test-" });
  try {
    const entryDir = join(dir, "entry");
    await Deno.mkdir(join(entryDir, "bin"), { recursive: true });
    // A generated entry package whose platform package is not installed: the
    // path that prints the reinstall hint.
    await Deno.writeTextFile(
      join(entryDir, "package.json"),
      `${
        JSON.stringify({ name: "@owner/opensac-installer", version: "1.0.0" })
      }\n`,
    );
    await Deno.copyFile(
      realWrapperSource(),
      join(entryDir, "bin", "opensac"),
    );
    await Deno.writeTextFile(
      join(entryDir, "bin", "platforms.js"),
      platformMapModule("@owner"),
    );
    const result = await new Deno.Command("node", {
      args: [join(entryDir, "bin", "opensac")],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.success, false, "a missing binary must exit non-zero");
    assertEquals(
      stderr.includes("npm install -g @owner/opensac-installer"),
      true,
      `the hint must name the scoped package, got: ${stderr}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("BuildNpmPackagesRejectsAnInvalidScope", async () => {
  const { dir, cleanup } = await makeRepo(["opensac-linux-amd64"]);
  try {
    await assertRejects(
      () => buildNpmPackages(dir, "1.0.0", { scope: "not a scope" }),
      Error,
      "scope",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("BuildNpmPackagesCopiesBinariesAndWritesManifests", async () => {
  const { dir, cleanup } = await makeRepo([
    "opensac-linux-amd64",
    "opensac-darwin-arm64",
    "opensac-windows-amd64.exe",
  ]);
  try {
    const built = await buildNpmPackages(dir, "1.2.3");
    assertEquals(built.map((t) => t.npmPlatform).sort(), [
      "darwin-arm64",
      "linux-x64",
      "win32-x64",
    ]);

    const linuxPkg = join(
      dir,
      "npm",
      "packages",
      "opensac-installer-linux-x64",
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(join(linuxPkg, "package.json")),
    );
    assertEquals(manifest.version, "1.2.3");
    assertEquals(manifest.os, ["linux"]);
    assertEquals(
      await Deno.readTextFile(join(linuxPkg, "bin", "opensac")),
      "binary",
    );

    // Windows keeps the .exe name inside its package.
    const winPkg = join(
      dir,
      "npm",
      "packages",
      "opensac-installer-win32-x64",
    );
    assertEquals(
      await Deno.readTextFile(join(winPkg, "bin", "opensac.exe")),
      "binary",
    );

    // The entry package lists exactly the packaged platforms, and keeps bin.
    const entry = JSON.parse(
      await Deno.readTextFile(join(dir, "npm", "package.json")),
    );
    assertEquals(entry.version, "1.2.3");
    assertEquals(Object.keys(entry.optionalDependencies).sort(), [
      "opensac-installer-darwin-arm64",
      "opensac-installer-linux-x64",
      "opensac-installer-win32-x64",
    ]);
    assertEquals(entry.bin, { opensac: "bin/opensac" });
  } finally {
    await cleanup();
  }
});

Deno.test("BuildNpmPackagesRemovesStalePackages", async () => {
  const { dir, cleanup } = await makeRepo(["opensac-linux-amd64"]);
  try {
    const stale = join(
      dir,
      "npm",
      "packages",
      "opensac-installer-plan9-x64",
    );
    await Deno.mkdir(stale, { recursive: true });
    await Deno.writeTextFile(join(stale, "package.json"), "{}");

    await buildNpmPackages(dir, "1.0.0");
    let exists = true;
    try {
      await Deno.stat(stale);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "a stale platform package must not survive");
  } finally {
    await cleanup();
  }
});

Deno.test("BuildNpmPackagesInstallsTheEntryWrapperAndBanner", async () => {
  const { dir, cleanup } = await makeRepo(["opensac-linux-amd64"]);
  try {
    await buildNpmPackages(dir, "1.0.0");
    const wrapper = join(dir, "npm", "bin", "opensac");
    assertEquals(
      await Deno.readTextFile(wrapper),
      "#!/usr/bin/env node\n",
      "the wrapper must be the repo's own copy",
    );
    // npm links bin/opensac, so it has to be executable.
    const mode = Number((await Deno.stat(wrapper)).mode ?? 0);
    assertEquals((mode & 0o111) > 0, true, `wrapper mode is ${mode}`);
    assertEquals(
      await Deno.readTextFile(join(dir, "npm", "scripts", "postinstall.js")),
      "// banner\n",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("InstallEntryAssetsReplacesAStaleWrapper", async () => {
  const { dir, cleanup } = await makeRepo(["opensac-linux-amd64"]);
  try {
    const binDir = join(dir, "npm", "bin");
    await Deno.mkdir(binDir, { recursive: true });
    await Deno.writeTextFile(join(binDir, "opensac-old"), "stale");
    await buildNpmPackages(dir, "1.0.0");
    let exists = true;
    try {
      await Deno.stat(join(binDir, "opensac-old"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await cleanup();
  }
});

Deno.test("GeneratedPlatformMapCoversEveryPlatform", () => {
  const source = platformMapModule();
  for (const target of PLATFORM_TARGETS) {
    assertEquals(
      source.includes(
        `${JSON.stringify(target.npmPlatform)}: ` +
          `${JSON.stringify(`opensac-installer-${target.npmPlatform}`)},`,
      ),
      true,
      `${target.npmPlatform} is missing from the generated map`,
    );
  }
  assertEquals(source.startsWith("// Generated by"), true);
});

Deno.test("BuildNpmPackagesWritesTheMapTheWrapperRequires", async () => {
  const { dir, cleanup } = await makeRepo(["opensac-linux-amd64"]);
  try {
    // The wrapper does `require('./platforms.js')`, so the map must land beside
    // it or every install breaks at first run.
    const wrapper = await Deno.readTextFile(
      join(dir, "scripts", WRAPPER_SOURCE),
    );
    await Deno.writeTextFile(
      join(dir, "scripts", WRAPPER_SOURCE),
      `${wrapper}require('./platforms.js');\n`,
    );
    await buildNpmPackages(dir, "1.0.0");
    const map = await Deno.readTextFile(
      join(dir, "npm", "bin", "platforms.js"),
    );
    assertEquals(
      map.includes('"linux-x64": "opensac-installer-linux-x64",'),
      true,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("BuildNpmPackagesRejectsAnEmptyBinDirectory", async () => {
  const { dir, cleanup } = await makeRepo([]);
  try {
    await assertRejects(
      () => buildNpmPackages(dir, "1.0.0"),
      Error,
      "build-all",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("BuildNpmPackagesSkipsAnEmptyBinaryFile", async () => {
  const { dir, cleanup } = await makeRepo([
    "opensac-linux-amd64",
    "opensac-darwin-arm64",
  ]);
  try {
    // A truncated binary is worse than a missing one: it would publish and then
    // fail at the user's first run, so it must not be packaged.
    await Deno.writeTextFile(join(dir, "bin", "opensac-darwin-arm64"), "");
    const built = await buildNpmPackages(dir, "1.0.0");
    assertEquals(built.map((t) => t.npmPlatform), ["linux-x64"]);
    const entry = JSON.parse(
      await Deno.readTextFile(join(dir, "npm", "package.json")),
    );
    assertEquals(Object.keys(entry.optionalDependencies), [
      "opensac-installer-linux-x64",
    ]);
  } finally {
    await cleanup();
  }
});
