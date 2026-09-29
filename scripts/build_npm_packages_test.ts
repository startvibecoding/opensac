import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildNpmPackages,
  INSTALLER_NAME,
  optionalDependencies,
  platformMapModule,
  platformPackageJson,
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
  for (const binary of binaries) {
    await Deno.writeTextFile(join(dir, "bin", binary), "binary");
  }
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
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
