import { assertEquals } from "@std/assert";
import {
  findPlatform,
  npmPlatformFor,
  PLATFORM_TARGETS,
  platformPackageName,
  resolveArch,
  WINDOWS_SUFFIX,
} from "./platforms.ts";

Deno.test("PlatformTargetsCoverLinuxDarwinAndWindows", () => {
  const oss = new Set(PLATFORM_TARGETS.map((target) => target.os));
  assertEquals([...oss].sort(), ["darwin", "linux", "win32"]);
  for (const target of PLATFORM_TARGETS) {
    assertEquals(
      ["x64", "arm64"].includes(target.cpu),
      true,
      `${target.npmPlatform} has an unexpected cpu`,
    );
  }
});

Deno.test("PlatformTargetsUseUniqueNames", () => {
  const npmPlatforms = PLATFORM_TARGETS.map((target) => target.npmPlatform);
  assertEquals(new Set(npmPlatforms).size, npmPlatforms.length);
  const binaries = PLATFORM_TARGETS.map((target) => target.binary);
  assertEquals(new Set(binaries).size, binaries.length);
  const triples = PLATFORM_TARGETS.map((target) => target.denoTarget);
  assertEquals(new Set(triples).size, triples.length);
});

Deno.test("WindowsPlatformsCarryTheExecutableSuffix", () => {
  for (const target of PLATFORM_TARGETS.filter((t) => t.os === "win32")) {
    assertEquals(target.binary.endsWith(WINDOWS_SUFFIX), true);
    assertEquals(target.innerBinary.endsWith(WINDOWS_SUFFIX), true);
  }
  for (const target of PLATFORM_TARGETS.filter((t) => t.os !== "win32")) {
    assertEquals(target.binary.endsWith(WINDOWS_SUFFIX), false);
    assertEquals(target.innerBinary, "opensac");
  }
});

Deno.test("FindPlatformResolvesKnownAndUnknownPlatforms", () => {
  assertEquals(
    findPlatform("linux-x64")?.denoTarget,
    "x86_64-unknown-linux-gnu",
  );
  assertEquals(findPlatform("plan9-x64"), undefined);
});

Deno.test("PlatformPackageNameDerivesFromTheInstallerName", () => {
  assertEquals(
    platformPackageName("darwin-arm64"),
    "opensac-installer-darwin-arm64",
  );
  assertEquals(
    platformPackageName("linux-x64", "opensac-pre-installer"),
    "opensac-pre-installer-linux-x64",
  );
});

Deno.test("NpmPlatformForMatchesTheProcessPlatformAndArch", () => {
  assertEquals(npmPlatformFor("linux", "x64"), "linux-x64");
  assertEquals(npmPlatformFor("darwin", "arm64"), "darwin-arm64");
  assertEquals(npmPlatformFor("win32", "x64"), "win32-x64");
  assertEquals(npmPlatformFor("sunos", "x64"), undefined);
  assertEquals(npmPlatformFor("linux", "mips"), undefined);
});

Deno.test("NpmPlatformForAcceptsDockerTargetArchNames", () => {
  // A Docker build only knows `TARGETARCH`; the image resolves its release
  // target through this function instead of a second, hand-written list.
  assertEquals(resolveArch("amd64"), "x64");
  assertEquals(resolveArch("x86_64"), "x64");
  assertEquals(resolveArch("arm64"), "arm64");
  assertEquals(resolveArch("riscv64"), "riscv64");
  assertEquals(npmPlatformFor("linux", "amd64"), "linux-x64");
  assertEquals(npmPlatformFor("linux", "arm64"), "linux-arm64");
  assertEquals(npmPlatformFor("linux", "riscv64"), undefined);
});
