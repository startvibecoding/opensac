import { assertEquals, assertRejects, assertThrows } from "../src/compat/assert.ts";
import { join } from "../src/compat/path.ts";
import {
import { test } from "#testing";
  authHeader,
  isPublished,
  packumentUrl,
  parseArgs,
  readPackageJson,
} from "./npm_publish_if_needed.ts";

/** Builds a fetch stub returning one status and a fixed body. */
function stubFetch(status: number, body: unknown = {}): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

/** Builds a fetch stub that records the URL it was called with. */
function recordingFetch(
  status: number,
  body: unknown,
  seen: { url?: string },
): typeof fetch {
  return ((input: string | URL | Request) => {
    seen.url = String(input);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
}

test("PackumentUrlEncodesScopedNames", () => {
  assertEquals(
    packumentUrl("https://registry.npmjs.org", "opensac"),
    "https://registry.npmjs.org/opensac",
  );
  assertEquals(
    packumentUrl("https://registry.npmjs.org/", "@scope/pkg"),
    "https://registry.npmjs.org/%40scope%2Fpkg",
  );
  assertEquals(
    packumentUrl("https://npm.pkg.github.com", "@scope/pkg"),
    "https://npm.pkg.github.com/%40scope%2Fpkg",
  );
});

test("RegistryCheckUsesThePackumentNotTheVersionRoute", async () => {
  // Regression: `GET /{package}/{version}` works on npmjs but GitHub Packages
  // answers 405, which aborted every `make npm-publish-github` on the first
  // platform package. The packument route is implemented by both.
  const seen: { url?: string } = {};
  await isPublished(
    "https://npm.pkg.github.com",
    "@scope/opensac-linux-x64",
    "0.0.3",
    recordingFetch(404, {}, seen),
  );
  assertEquals(
    seen.url,
    "https://npm.pkg.github.com/%40scope%2Fopensac-linux-x64",
  );
  if ((seen.url ?? "").includes("/0.0.3")) {
    throw new Error("the version route is not supported by GitHub Packages");
  }
});

test("AuthHeaderUsesTheWorkflowTokenWhenPresent", () => {
  assertEquals(
    authHeader({ get: (k) => (k === "NODE_AUTH_TOKEN" ? "t" : undefined) }),
    { Authorization: "Bearer t" },
  );
  assertEquals(
    authHeader({ get: (k) => (k === "NPM_TOKEN" ? "n" : undefined) }),
    { Authorization: "Bearer n" },
  );
  // No token must not send an empty Authorization header.
  assertEquals(authHeader({ get: () => undefined }), {});
  assertEquals(authHeader({ get: () => "" }), {});
});

test("ReadPackageJsonRequiresNameAndVersion", async () => {
  const dir = await Deno.makeTempDir({ prefix: "opensac-publish-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "opensac", version: "1.0.0" }),
    );
    assertEquals(await readPackageJson(dir), {
      name: "opensac",
      version: "1.0.0",
    });

    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "opensac" }),
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

test("IsPublishedReadsTheVersionOutOfThePackument", async () => {
  const registry = "https://registry.npmjs.org";
  const packument = { versions: { "1.0.0": {}, "2.0.0": {} } };
  assertEquals(
    await isPublished(
      registry,
      "opensac",
      "1.0.0",
      stubFetch(200, packument),
    ),
    true,
  );
  // The packument existing does not mean this version does.
  assertEquals(
    await isPublished(
      registry,
      "opensac",
      "3.0.0",
      stubFetch(200, packument),
    ),
    false,
  );
  assertEquals(
    await isPublished(registry, "opensac", "1.0.0", stubFetch(404)),
    false,
  );
});

test("IsPublishedRejectsAPackumentWithoutAVersionsMap", async () => {
  // A 200 that is not a usable packument must not read as "not published",
  // or a registry returning an error page with 200 would republish a version
  // that is already live.
  await assertRejects(
    () =>
      isPublished(
        "https://registry.npmjs.org",
        "opensac",
        "1.0.0",
        stubFetch(200, { error: "unauthorized" }),
      ),
    Error,
    "no versions",
  );
});

test("IsPublishedRefusesToGuessOnAServerError", async () => {
  // A 500 must not read as "not published", or a registry outage would
  // republish a version that is already live. GitHub Packages answers the
  // unsupported version route with 405, which is the same class of failure.
  await assertRejects(
    () =>
      isPublished(
        "https://registry.npmjs.org",
        "opensac",
        "1.0.0",
        stubFetch(500),
      ),
    Error,
    "HTTP 500",
  );
  await assertRejects(
    () =>
      isPublished(
        "https://npm.pkg.github.com",
        "@scope/opensac",
        "1.0.0",
        stubFetch(405),
      ),
    Error,
    "HTTP 405",
  );
});

test("ParseArgsReadsTagRegistryAndPackageDir", () => {
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

test("ParseArgsForwardsEverythingAfterTheSeparator", () => {
  const parsed = parseArgs(
    ["--tag", "next", "--", "--provenance", "--access", "public"],
    { registry: "https://registry.npmjs.org", tag: "latest" },
  );
  assertEquals(parsed.extraArgs, ["--provenance", "--access", "public"]);
  assertEquals(parsed.tag, "next");
});

test("ParseArgsRejectsAMissingFlagValue", () => {
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

test("ParseArgsRejectsUnknownOptionsAndExtraDirectories", () => {
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
