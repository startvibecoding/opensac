import { assertEquals } from "@opensac/assert";
import { join } from "@opensac/path";
import {
  packageVersion,
  pickLatestVersionTag,
  resolveBuildVersion,
  toPackageVersion,
} from "./version.ts";

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

Deno.test("ToPackageVersionStripsTheVPrefixAndDirtySuffix", () => {
  assertEquals(toPackageVersion("v1.2.3"), "1.2.3");
  assertEquals(toPackageVersion("v1.2.3-dirty"), "1.2.3");
  assertEquals(toPackageVersion("0.1.0"), "0.1.0");
  assertEquals(toPackageVersion("  v2.0.0  "), "2.0.0");
  assertEquals(toPackageVersion(""), "");
});
