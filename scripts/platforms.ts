// Release platform table shared by the build script and the npm packager.
//
// One owner for every platform fact: the `deno compile --target` triple, the
// binary name produced in `bin/`, and the npm `os`/`cpu` fields used to select a
// platform package at install time. `scripts/build.ts` compiles from this table
// and `scripts/build_npm_packages.ts` generates packages from it, so a platform
// can never be buildable but unpublishable (or the reverse).

/** One release target: how to compile it and how npm names it. */
export interface PlatformTarget {
  /** npm platform suffix, also the platform package name suffix. */
  readonly npmPlatform: string;
  /** `deno compile --target` triple. */
  readonly denoTarget: string;
  /** Binary file name written into `bin/`. */
  readonly binary: string;
  /** npm `os` field. */
  readonly os: string;
  /** npm `cpu` field. */
  readonly cpu: string;
  /** Binary file name inside the platform package. */
  readonly innerBinary: string;
}

/** Executable suffix for compiled Windows binaries. */
export const WINDOWS_SUFFIX = ".exe";

/**
 * Every platform opensac releases.
 *
 * This is exactly the set `deno compile --target` accepts, so a build never
 * fails on an unsupported triple and a published platform package always has a
 * binary behind it. Deno ships no musl or BSD runtime, so there is no musl or
 * BSD platform to publish and no libc field to disagree about.
 */
export const PLATFORM_TARGETS: readonly PlatformTarget[] = [
  {
    npmPlatform: "linux-x64",
    denoTarget: "x86_64-unknown-linux-gnu",
    binary: "opensac-linux-amd64",
    os: "linux",
    cpu: "x64",
    innerBinary: "opensac",
  },
  {
    npmPlatform: "linux-arm64",
    denoTarget: "aarch64-unknown-linux-gnu",
    binary: "opensac-linux-arm64",
    os: "linux",
    cpu: "arm64",
    innerBinary: "opensac",
  },
  {
    npmPlatform: "darwin-x64",
    denoTarget: "x86_64-apple-darwin",
    binary: "opensac-darwin-amd64",
    os: "darwin",
    cpu: "x64",
    innerBinary: "opensac",
  },
  {
    npmPlatform: "darwin-arm64",
    denoTarget: "aarch64-apple-darwin",
    binary: "opensac-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    innerBinary: "opensac",
  },
  {
    npmPlatform: "win32-x64",
    denoTarget: "x86_64-pc-windows-msvc",
    binary: "opensac-windows-amd64.exe",
    os: "win32",
    cpu: "x64",
    innerBinary: `opensac${WINDOWS_SUFFIX}`,
  },
  {
    npmPlatform: "win32-arm64",
    denoTarget: "aarch64-pc-windows-msvc",
    binary: "opensac-windows-arm64.exe",
    os: "win32",
    cpu: "arm64",
    innerBinary: `opensac${WINDOWS_SUFFIX}`,
  },
];

/** Looks up a platform by its npm suffix, or undefined when unknown. */
export function findPlatform(
  npmPlatform: string,
): PlatformTarget | undefined {
  return PLATFORM_TARGETS.find((target) => target.npmPlatform === npmPlatform);
}

/** npm package name for one platform, e.g. `opensac-installer-linux-x64`. */
export function platformPackageName(
  npmPlatform: string,
  installerName = "opensac-installer",
): string {
  return `${installerName}-${npmPlatform}`;
}

/**
 * Go/Docker style arch names mapped to the npm `cpu` field.
 *
 * `process.arch` and `Deno.build.arch` both say `x64`, while a Docker
 * `TARGETARCH` (and a Go `GOARCH`) says `amd64` for the same machine. Accepting
 * both spellings is what lets the image build resolve its target from the
 * platform table instead of hardcoding a second list of platforms.
 */
export const ARCH_ALIASES: Readonly<Record<string, string>> = {
  amd64: "x64",
  x86_64: "x64",
};

/** Resolves a `process.arch`, `Deno.build.arch`, or `TARGETARCH` spelling. */
export function resolveArch(arch: string): string {
  return ARCH_ALIASES[arch] ?? arch;
}

/**
 * npm `os`/`cpu` for a `process.platform`/`process.arch` pair, or "" when the
 * pair has no published platform. The install wrapper uses this to report an
 * unsupported host with the same table the packages were built from.
 */
export function npmPlatformFor(
  os: string,
  arch: string,
): string | undefined {
  const cpu = resolveArch(arch);
  const match = PLATFORM_TARGETS.find(
    (target) => target.os === os && target.cpu === cpu,
  );
  return match?.npmPlatform;
}
