import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { verifyPlatformPackages } from "./npm_verify_platforms.ts";

/**
 * Fetch stub that answers per package, defaulting to 404.
 *
 * `isPublished` reads the packument route (`/{package}`) and looks the version
 * up in its `versions` map, because GitHub Packages does not implement the
 * `/{package}/{version}` route and answers it with 405. `published` is still
 * keyed `name@version` so the tests read the same as the manifests they check.
 */
function registryFetch(
  published: Record<string, number>,
): typeof fetch {
  const byName = new Map<string, Record<string, number>>();
  for (const [key, status] of Object.entries(published)) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const entry = byName.get(name) ?? {};
    entry[key.slice(at + 1)] = status;
    byName.set(name, entry);
  }
  return ((input: string | URL | Request) => {
    const raw = String(input instanceof Request ? input.url : input)
      .replace(/\/+$/, "");
    const name = decodeURIComponent(raw.slice(raw.lastIndexOf("/") + 1));
    const versions = byName.get(name);
    if (versions === undefined) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    // Preserve a non-200 answer so a registry failure still surfaces.
    const failure = Object.values(versions).find((status) => status !== 200);
    if (failure !== undefined) {
      return Promise.resolve(new Response("{}", { status: failure }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ versions }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
}

/** Writes a temp entry manifest with the given optionalDependencies. */
async function writeManifest(
  deps: Record<string, string>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "opensac-verify-test-" });
  const path = join(dir, "package.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      name: "opensac-installer",
      version: "1.0.0",
      optionalDependencies: deps,
    }),
  );
  return { path, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("VerifyPlatformPackagesPassesWhenEveryPlatformExists", async () => {
  const { path, cleanup } = await writeManifest({
    "opensac-installer-linux-x64": "1.0.0",
    "opensac-installer-darwin-arm64": "1.0.0",
  });
  try {
    const missing = await verifyPlatformPackages(
      path,
      "https://registry.npmjs.org",
      registryFetch({
        "opensac-installer-linux-x64@1.0.0": 200,
        "opensac-installer-darwin-arm64@1.0.0": 200,
      }),
    );
    assertEquals(missing, []);
  } finally {
    await cleanup();
  }
});

Deno.test("VerifyPlatformPackagesReportsAMissingPlatform", async () => {
  const { path, cleanup } = await writeManifest({
    "opensac-installer-linux-x64": "1.0.0",
    "opensac-installer-win32-x64": "1.0.0",
  });
  try {
    const missing = await verifyPlatformPackages(
      path,
      "https://registry.npmjs.org",
      registryFetch({ "opensac-installer-linux-x64@1.0.0": 200 }),
    );
    assertEquals(missing.map((item) => item.name), [
      "opensac-installer-win32-x64",
    ]);
    assertEquals(missing[0].reason, "not published");
  } finally {
    await cleanup();
  }
});

Deno.test("VerifyPlatformPackagesSurfacesARegistryFailure", async () => {
  const { path, cleanup } = await writeManifest({
    "opensac-installer-linux-x64": "1.0.0",
  });
  try {
    // A 500 must appear as a missing platform, not as a silent pass.
    const missing = await verifyPlatformPackages(
      path,
      "https://registry.npmjs.org",
      registryFetch({ "opensac-installer-linux-x64@1.0.0": 500 }),
    );
    assertEquals(missing.length, 1);
    assertEquals(missing[0].reason.includes("HTTP 500"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("VerifyPlatformPackagesRejectsAManifestWithNoPlatforms", async () => {
  const { path, cleanup } = await writeManifest({});
  try {
    await assertRejects(
      () =>
        verifyPlatformPackages(
          path,
          "https://registry.npmjs.org",
          registryFetch({}),
        ),
      Error,
      "no optionalDependencies",
    );
  } finally {
    await cleanup();
  }
});
