import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  isPublished,
  parseArgs,
  readPackageJson,
  versionUrl,
} from "./npm_publish_if_needed.ts";

/** Builds a fetch stub returning one status. */
function stubFetch(status: number): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response("{}", { status }),
    )) as unknown as typeof fetch;
}

Deno.test("VersionUrlEncodesScopedNames", () => {
  assertEquals(
    versionUrl("https://registry.npmjs.org", "opensac-installer", "1.2.3"),
    "https://registry.npmjs.org/opensac-installer/1.2.3",
  );
  assertEquals(
    versionUrl("https://registry.npmjs.org/", "@scope/pkg", "1.0.0"),
    "https://registry.npmjs.org/%40scope%2Fpkg/1.0.0",
  );
});

Deno.test("ReadPackageJsonRequiresNameAndVersion", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-publish-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "opensac-installer", version: "1.0.0" }),
    );
    assertEquals(await readPackageJson(dir), {
      name: "opensac-installer",
      version: "1.0.0",
    });

    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "opensac-installer" }),
    );
    await assertRejects(
      () => readPackageJson(dir),
      Error,
      "name and a version",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("IsPublishedTreatsOkAsPublishedAndNotFoundAsMissing", async () => {
  const registry = "https://registry.npmjs.org";
  assertEquals(
    await isPublished(registry, "opensac-installer", "1.0.0", stubFetch(200)),
    true,
  );
  assertEquals(
    await isPublished(registry, "opensac-installer", "1.0.0", stubFetch(404)),
    false,
  );
});

Deno.test("IsPublishedRefusesToGuessOnAServerError", async () => {
  // A 500 must not read as "not published", or a registry outage would
  // republish a version that is already live.
  await assertRejects(
    () =>
      isPublished(
        "https://registry.npmjs.org",
        "opensac-installer",
        "1.0.0",
        stubFetch(500),
      ),
    Error,
    "HTTP 500",
  );
});

Deno.test("ParseArgsReadsTagRegistryAndPackageDir", () => {
  const defaults = { registry: "https://registry.npmjs.org", tag: "latest" };
  assertEquals(parseArgs(["--tag", "next", "npm"], defaults), {
    registry: "https://registry.npmjs.org",
    tag: "next",
    packageDir: "npm",
    extraArgs: [],
  });
  assertEquals(
    parseArgs(["--registry", "https://r.example/", "npm/packages/a"], defaults),
    {
      registry: "https://r.example/",
      tag: "latest",
      packageDir: "npm/packages/a",
      extraArgs: [],
    },
  );
  assertEquals(parseArgs([], defaults), {
    registry: "https://registry.npmjs.org",
    tag: "latest",
    packageDir: undefined,
    extraArgs: [],
  });
});

Deno.test("ParseArgsForwardsEverythingAfterTheSeparator", () => {
  const parsed = parseArgs(
    ["--tag", "next", "--", "--provenance", "--access", "public"],
    { registry: "https://registry.npmjs.org", tag: "latest" },
  );
  assertEquals(parsed.extraArgs, ["--provenance", "--access", "public"]);
  assertEquals(parsed.tag, "next");
});

Deno.test("ParseArgsRejectsAMissingFlagValue", () => {
  const defaults = { registry: "https://registry.npmjs.org", tag: "latest" };
  // parseArgs throws synchronously, so assertThrows is the matching assertion.
  assertThrows(
    () => parseArgs(["--tag"], defaults),
    Error,
    "requires a value",
  );
  assertThrows(
    () => parseArgs(["--registry"], defaults),
    Error,
    "requires a value",
  );
});

Deno.test("ParseArgsRejectsUnknownOptionsAndExtraDirectories", () => {
  const defaults = { registry: "https://registry.npmjs.org", tag: "latest" };
  assertThrows(
    () => parseArgs(["--provenance"], defaults),
    Error,
    "Unknown option",
  );
  assertThrows(
    () => parseArgs(["npm", "npm/other"], defaults),
    Error,
    "Unexpected extra package directory",
  );
});
