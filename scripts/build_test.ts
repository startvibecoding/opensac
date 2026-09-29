import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildEnvFile,
  compileArgs,
  explicitBuildVersion,
  packageVersion,
  pickLatestVersionTag,
  resolveBuildVersion,
} from "./build.ts";

Deno.test("PickLatestVersionTagTakesNewestFirst", () => {
  assertEquals(
    pickLatestVersionTag("v0.3.0\nv0.2.1\nv0.2.0\n"),
    "v0.3.0",
  );
});

Deno.test("PickLatestVersionTagSkipsBlankLines", () => {
  assertEquals(pickLatestVersionTag("\n  \nv1.0.0\n"), "v1.0.0");
});

Deno.test("PickLatestVersionTagIsEmptyWithoutTags", () => {
  assertEquals(pickLatestVersionTag(""), "");
  assertEquals(pickLatestVersionTag("\n \n"), "");
});

Deno.test("PackageVersionReadsDenoJson", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-build-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "opensac", version: "1.4.2" }),
    );
    assertEquals(await packageVersion(dir), "1.4.2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PackageVersionIsEmptyWithoutManifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-build-test-" });
  try {
    assertEquals(await packageVersion(dir), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ResolveBuildVersionPrefersGitTag", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-build-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ version: "1.4.2" }),
    );
    const version = await resolveBuildVersion(
      dir,
      () => Promise.resolve("v9.9.9\n"),
    );
    assertEquals(version, "v9.9.9");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ResolveBuildVersionFallsBackToPackageVersion", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-build-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ version: "1.4.2" }),
    );
    const version = await resolveBuildVersion(dir, () => Promise.resolve(""));
    assertEquals(version, "1.4.2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("BuildEnvFileCarriesBuildVersion", () => {
  assertEquals(buildEnvFile("v1.2.3"), "OPENSAC_BUILD_VERSION=v1.2.3\n");
});

Deno.test("ExplicitBuildVersionOverridesTheGitTag", () => {
  assertEquals(explicitBuildVersion(["--build-version=v9.9.9"]), "v9.9.9");
  assertEquals(
    explicitBuildVersion(["--target=linux-x64", "--build-version= v1.0.0 "]),
    "v1.0.0",
  );
  // Absent means "resolve it the usual way", which the container image build
  // relies on when it does not pass a tag.
  assertEquals(explicitBuildVersion(["--all"]), undefined);
  assertEquals(explicitBuildVersion([]), undefined);
});

Deno.test("ExplicitBuildVersionRejectsAnEmptyValue", () => {
  let message = "";
  try {
    explicitBuildVersion(["--build-version="]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("requires a version"), true, message);
});

Deno.test("CompileArgsEmbedEnvFileBeforeEntry", () => {
  const args = compileArgs("/tmp/opensac-build.env");
  assertEquals(args[0], "compile");
  assertEquals(args[1], "-A");
  assertEquals(args[2], "--env-file=/tmp/opensac-build.env");
  assertEquals(args.at(-3), "-o");
  assertEquals(args.at(-2), "bin/opensac");
  assertEquals(args.at(-1), "src/main.ts");
});
