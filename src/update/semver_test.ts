import { assert, assertEquals } from "@std/assert";
import { canonical, compare, isValid } from "./semver.ts";

// TestSemverIsValid pins the x/mod/semver parse rules the update package relies
// on: a leading "v" is mandatory, minor/patch are optional, numeric identifiers
// must not carry a leading zero, and build metadata (unlike prerelease) may.
Deno.test("semver isValid accepts canonical and short forms", () => {
  const valid = [
    "v0.0.0",
    "v1",
    "v1.2",
    "v1.2.3",
    "v1.2.3-alpha",
    "v1.2.3-alpha.1",
    "v1.2.3-rc.1+build.7",
    "v1.2.3-alpha-",
    "v10.20.30",
    "v1.2.3+01",
  ];
  for (const v of valid) assert(isValid(v), `expected ${v} to be valid`);
});

Deno.test("semver isValid rejects malformed versions", () => {
  const invalid = [
    "",
    "1.2.3",
    "version-1.2.3",
    "v",
    "vx.y.z",
    "v1.",
    "v1.02.3",
    "v1.2.3.4",
    // Prerelease/build metadata attaches to the full major.minor.patch form
    // only, matching x/mod/semver's parse order.
    "v1-alpha",
    "v1+build",
    "v1.2-alpha",
    "v1.2.3-",
    "v1.2.3-01",
    "v1.2.3-alpha..1",
    "v1.2.3+alpha..1",
    "v1.2.3-beta+",
    "v1.2.3 ",
    " v1.2.3",
  ];
  for (const v of invalid) assert(!isValid(v), `expected ${v} to be invalid`);
});

Deno.test("semver canonical fills minor and patch and drops build metadata", () => {
  assertEquals(canonical("v1"), "v1.0.0");
  assertEquals(canonical("v1.2"), "v1.2.0");
  assertEquals(canonical("v1.2.3"), "v1.2.3");
  assertEquals(canonical("v1.2.3-alpha.1"), "v1.2.3-alpha.1");
  assertEquals(canonical("v1.2.3+build.7"), "v1.2.3");
  // Prerelease/build metadata requires the full x.y.z form, so a short
  // version carrying metadata is invalid and canonicalizes to "".
  assertEquals(canonical("v1+build"), "");
  assertEquals(canonical("not-a-version"), "");
  assertEquals(canonical(""), "");
});

Deno.test("semver compare orders releases, prereleases, and invalid versions", () => {
  const cases: Array<[string, string, number]> = [
    ["v1.2.3", "v1.2.3", 0],
    ["v2.0.0", "v1.9.9", 1],
    ["v1.2.3", "v1.10.0", -1],
    ["v1.2.3", "v1.2.4", -1],
    // Build metadata never affects precedence.
    ["v1.2.3+build", "v1.2.3", 0],
    // A release outranks any prerelease.
    ["v1.2.3-alpha", "v1.2.3", -1],
    ["v1.2.3", "v1.2.3-rc.1", 1],
    // Numeric prerelease identifiers rank below alphanumeric ones.
    ["v1.2.3-1", "v1.2.3-alpha", -1],
    ["v1.2.3-alpha.1", "v1.2.3-alpha.beta", -1],
    ["v1.2.3-alpha.beta", "v1.2.3-beta", -1],
    // Numeric identifiers compare numerically, not lexically.
    ["v1.2.3-beta.2", "v1.2.3-beta.11", -1],
    // A larger set of identifiers wins when the common prefix is equal.
    ["v1.2.3-rc.1", "v1.2.3-rc.1.1", -1],
    ["v1.2.3-rc.1.1", "v1.2.3-rc.1", 1],
    // Invalid versions sort below valid ones and equal each other.
    ["bogus", "v0.0.1", -1],
    ["v0.0.1", "bogus", 1],
    ["bogus", "also-bogus", 0],
  ];
  for (const [v, w, want] of cases) {
    assertEquals(compare(v, w), want, `compare(${v}, ${w})`);
  }
});
