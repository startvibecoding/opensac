// Ported from internal/platform/platform.go
//
// Package platform provides cross-platform compatibility utilities.

import * as path from "@std/path";

const APP_DIR_NAME = "mothx";

// ─────────────────────────────────────────────────────────────────────────────
// OS detection
// ─────────────────────────────────────────────────────────────────────────────

/** Maps Deno's OS identifier to Go's GOOS value. */
function goos(): string {
  const o: string = Deno.build.os;
  switch (o) {
    case "windows":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "freebsd":
      return "freebsd";
    case "openbsd":
      return "openbsd";
    case "netbsd":
      return "netbsd";
    case "aix":
      return "aix";
    case "solaris":
      return "solaris";
    default:
      return o;
  }
}

/** Returns the current operating system: "windows", "darwin", "linux", etc. */
export function os(): string {
  return goos();
}

export function isWindows(): boolean {
  return goos() === "windows";
}

export function isMacOS(): boolean {
  return goos() === "darwin";
}

export function isLinux(): boolean {
  return goos() === "linux";
}

export function isFreeBSD(): boolean {
  return goos() === "freebsd";
}

export function isOpenBSD(): boolean {
  return goos() === "openbsd";
}

export function isNetBSD(): boolean {
  return goos() === "netbsd";
}

export function isDragonflyBSD(): boolean {
  return goos() === "dragonfly";
}

export function isBSD(): boolean {
  switch (goos()) {
    case "freebsd":
    case "openbsd":
    case "netbsd":
    case "dragonfly":
      return true;
    default:
      return false;
  }
}

export function isSolaris(): boolean {
  switch (goos()) {
    case "solaris":
    case "illumos":
      return true;
    default:
      return false;
  }
}

export function isAIX(): boolean {
  return goos() === "aix";
}

export function isPlan9(): boolean {
  return goos() === "plan9";
}

export function isUnix(): boolean {
  switch (goos()) {
    case "windows":
    case "plan9":
      return false;
    default:
      return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Architecture detection
// ─────────────────────────────────────────────────────────────────────────────

/** Maps Deno's architecture identifier to Go's GOARCH value. */
function goarch(): string {
  const a: string = Deno.build.arch;
  switch (a) {
    case "x86_64":
      return "amd64";
    case "aarch64":
      return "arm64";
    case "arm":
      return "arm";
    case "x86":
      return "386";
    case "riscv64":
      return "riscv64";
    case "ppc64":
      return "ppc64";
    case "ppc64le":
      return "ppc64le";
    case "s390x":
      return "s390x";
    case "loong64":
      return "loong64";
    default:
      return a;
  }
}

/** Returns the current architecture: "amd64", "arm64", "386", etc. */
export function arch(): string {
  return goarch();
}

export function isAMD64(): boolean {
  return goarch() === "amd64";
}

export function isARM64(): boolean {
  return goarch() === "arm64";
}

export function isARM(): boolean {
  return goarch() === "arm";
}

export function is386(): boolean {
  return goarch() === "386";
}

export function is64Bit(): boolean {
  switch (goarch()) {
    case "amd64":
    case "arm64":
    case "ppc64":
    case "ppc64le":
    case "mips64":
    case "mips64le":
    case "s390x":
    case "riscv64":
    case "loong64":
      return true;
    default:
      return false;
  }
}

export function isLittleEndian(): boolean {
  switch (goarch()) {
    case "amd64":
    case "arm64":
    case "arm":
    case "386":
    case "riscv64":
    case "loong64":
    case "mips64le":
    case "mipsle":
    case "ppc64le":
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the user's home directory. */
export function homeDir(): string {
  const home = Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ?? "";
  if (home !== "") return home;
  try {
    const cwd = Deno.cwd();
    if (cwd !== "") return cwd;
  } catch {
    // ignore
  }
  return path.SEPARATOR;
}

/** Returns the platform-specific configuration directory. */
export function configDir(): string {
  const dir = Deno.env.get("MOTHX_DIR");
  if (dir) return dir;
  return configDirForOS(
    goos(),
    homeDir(),
    Deno.env.get("APPDATA") ?? "",
  );
}

function configDirForOS(
  goosValue: string,
  home: string,
  appData: string,
): string {
  switch (goosValue) {
    case "windows":
      if (appData !== "") return path.join(appData, APP_DIR_NAME);
      return path.join(home, "AppData", "Roaming", APP_DIR_NAME);
    default: // unix-like and others
      return path.join(home, "." + APP_DIR_NAME);
  }
}

/** Reports whether the user selected a custom config dir. */
export function configDirOverridden(): boolean {
  return (Deno.env.get("MOTHX_DIR") ?? "") !== "";
}

/** Returns the platform-specific data directory. */
export function dataDir(): string {
  return configDir();
}

/** Returns the platform-specific cache directory. */
export function cacheDir(): string {
  switch (goos()) {
    case "windows": {
      const localAppData = Deno.env.get("LOCALAPPDATA");
      if (localAppData) return path.join(localAppData, APP_DIR_NAME, "cache");
      return path.join(homeDir(), "AppData", "Local", APP_DIR_NAME, "cache");
    }
    case "darwin":
      return path.join(homeDir(), "Library", "Caches", APP_DIR_NAME);
    default: { // linux, BSD, Solaris, illumos, AIX, and others
      const cacheHome = Deno.env.get("XDG_CACHE_HOME");
      if (cacheHome) return path.join(cacheHome, APP_DIR_NAME);
      return path.join(homeDir(), ".cache", APP_DIR_NAME);
    }
  }
}

/** Opens `p` with the platform default application. */
export function openFile(p: string): void {
  let candidates: string[][];
  switch (goos()) {
    case "darwin":
      candidates = [["open", p]];
      break;
    case "windows":
      candidates = [["cmd", "/c", "start", "", p]];
      break;
    default:
      candidates = [["xdg-open", p], ["gio", "open", p]];
  }
  for (const candidate of candidates) {
    if (lookPathSync(candidate[0]) === null) continue;
    const cmd = new Deno.Command(candidate[0], {
      args: candidate.slice(1),
      stdout: "null",
      stderr: "null",
    });
    cmd.spawn();
    return;
  }
  throw new Error(`executable file not found in $PATH: ${candidates[0][0]}`);
}

/** Returns the platform-specific session directory. */
export function sessionDir(): string {
  return path.join(configDir(), "sessions");
}

/** Returns the platform-specific skills directory. */
export function skillsDir(): string {
  return path.join(configDir(), "skills");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the default shell for the current platform. */
export function defaultShell(): string {
  const shell = Deno.env.get("SHELL") ?? "";
  if (isExecutableAbsolutePath(shell)) return shell;

  return defaultShellForOS(
    goos(),
    isExecutableAbsolutePath,
    (name: string) => lookPathSync(name) !== null,
  );
}

function defaultShellForOS(
  goosValue: string,
  isExecutable: (p: string) => boolean,
  lookPathFn: (name: string) => boolean,
): string {
  switch (goosValue) {
    case "windows":
      if (lookPathFn("powershell.exe")) return "powershell.exe";
      return "cmd.exe";
    case "darwin":
      if (isExecutable("/bin/zsh")) return "/bin/zsh";
      return "/bin/sh";
    case "linux":
      if (isExecutable("/bin/bash")) return "/bin/bash";
      return "/bin/sh";
    case "plan9":
      return "/bin/rc";
    default: // BSD, Solaris, illumos, AIX, and others
      return "/bin/sh";
  }
}

function isExecutableAbsolutePath(p: string): boolean {
  if (p === "" || !path.isAbsolute(p)) return false;
  try {
    const info = Deno.statSync(p);
    if (info.isDirectory) return false;
    return ((info.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Searches `PATH` for `name`. Returns the resolved path or null. */
export function lookPathSync(name: string): string | null {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const sep = isWindows() ? ";" : ":";
  const exts = isWindows()
    ? (Deno.env.get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const dir of pathEnv.split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableAbsolutePath(candidate)) return candidate;
    }
  }
  return null;
}

/** Returns the arguments to execute a command in the shell. */
export function shellArgs(shell: string, command: string): string[] {
  let shellName = path.basename(shell).toLowerCase();
  const ext = path.extname(shellName);
  if (ext) shellName = shellName.slice(0, -ext.length);
  if (shellName.startsWith("busybox")) return ["sh", "-c", command];
  if (shellName === "powershell" || shellName === "pwsh") {
    return ["-NoProfile", "-NonInteractive", "-Command", command];
  }
  if (shellName === "cmd") return ["/c", command];
  if (shellName === "rc") return ["-c", command];
  return ["-c", command]; // bash, zsh, sh, ksh, csh, etc.
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the platform-specific path separator. */
export function pathSeparator(): string {
  return path.SEPARATOR;
}

/** Joins path elements using the platform-specific separator. */
export function joinPath(...elem: string[]): string {
  if (elem.length === 0) return "";
  return path.join(elem[0], ...elem.slice(1));
}

/** Normalizes a path for the current platform. */
export function normalizePath(p: string): string {
  return isWindows() ? p.replaceAll("/", "\\") : p;
}

/** Expands `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = homeDir();
  if (home === "") return p;
  if (p === "~") return home;
  if (p.length > 1 && (p[1] === "/" || p[1] === "\\")) {
    return path.join(home, p.slice(2));
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-specific paths and environment
// ─────────────────────────────────────────────────────────────────────────────

/** Returns platform-specific common system paths. */
export function commonPaths(): Record<string, string> {
  switch (goos()) {
    case "windows":
      return {
        home: homeDir(),
        temp: tempDir(),
        appData: Deno.env.get("APPDATA") ?? "",
        localApp: Deno.env.get("LOCALAPPDATA") ?? "",
        programFiles: Deno.env.get("ProgramFiles") ?? "",
      };
    case "darwin":
      return {
        home: homeDir(),
        temp: tempDir(),
        appSupport: path.join(homeDir(), "Library", "Application Support"),
        caches: path.join(homeDir(), "Library", "Caches"),
      };
    case "plan9":
      return { home: homeDir(), temp: tempDir() };
    default:
      return {
        home: homeDir(),
        temp: tempDir(),
        cache: path.join(homeDir(), ".cache"),
        config: path.join(homeDir(), ".config"),
        local: path.join(homeDir(), ".local"),
      };
  }
}

/** Returns paths that should be accessible in sandbox mode. */
export function sandboxPaths(): string[] {
  switch (goos()) {
    case "windows":
      return ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"];
    case "darwin":
      return ["/usr", "/lib", "/bin", "/sbin", "/System", "/Library"];
    case "linux":
      return [
        "/usr",
        "/lib",
        "/lib64",
        "/bin",
        "/sbin",
        "/etc/ld.so.cache",
        "/etc/ssl",
        "/etc/ca-certificates",
        "/dev/null",
        "/dev/urandom",
        "/dev/zero",
      ];
    default:
      return [];
  }
}

/** Returns paths that should be denied in sandbox mode. */
export function deniedPaths(): string[] {
  switch (goos()) {
    case "windows":
      return [
        path.join(homeDir(), "Documents"),
        path.join(homeDir(), "Desktop"),
      ];
    case "plan9":
      return [];
    default:
      return ["/etc/shadow", "/etc/gshadow", "/etc/passwd", "/root"];
  }
}

/** Returns environment variables to pass through sandbox. */
export function defaultEnvVars(): string[] {
  const common = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM"];
  switch (goos()) {
    case "windows":
      return [
        ...common,
        "APPDATA",
        "LOCALAPPDATA",
        "COMPUTERNAME",
        "USERPROFILE",
        "SYSTEMROOT",
      ];
    case "darwin":
      return [...common, "SHELL", "TMPDIR"];
    case "plan9":
      return ["path", "home", "user", "service"];
    default:
      return [
        ...common,
        "SHELL",
        "GOPATH",
        "GOROOT",
        "GOPROXY",
        "GOMODCACHE",
        "NODE_PATH",
      ];
  }
}

/** Returns the platform-specific temp directory. */
export function tempDir(): string {
  const env = Deno.env.get("TMPDIR") ?? Deno.env.get("TEMP") ??
    Deno.env.get("TMP") ?? "";
  if (env !== "") return env;
  return isWindows() ? "C:\\Windows\\Temp" : "/tmp";
}

/** Returns the platform-specific executable extension. */
export function executableExt(): string {
  return isWindows() ? ".exe" : "";
}

/** Checks if a file mode is executable on the current platform. */
export function isExecutable(mode: number): boolean {
  if (isWindows()) return true; // Simplified, matching the Go original.
  return (mode & 0o111) !== 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedded Windows BusyBox (ported from internal/platform/busybox_windows.go
// and busybox_other.go).
// ─────────────────────────────────────────────────────────────────────────────

let busyboxOnce = false;
let busyboxPathValue = "";
let busyboxErr: Error | undefined;

/**
 * Extracts the embedded BusyBox executable for the current Windows
 * architecture into the Windows config bin directory when it is missing.
 * Non-Windows platforms report success with no path.
 */
export function ensureWindowsBusybox(): Error | undefined {
  if (busyboxOnce) return busyboxErr;
  busyboxOnce = true;
  if (!isWindows()) return undefined;
  try {
    busyboxPathValue = ensureWindowsBusyboxPath();
  } catch (err) {
    busyboxErr = err instanceof Error ? err : new Error(String(err));
  }
  return busyboxErr;
}

/** Reports whether a busybox path is available. */
export interface BusyboxPathResult {
  path: string;
  ok: boolean;
}

/** Returns the extracted BusyBox path when available. */
export function windowsBusyboxPath(): BusyboxPathResult {
  if (ensureWindowsBusybox() != null) return { path: "", ok: false };
  if (busyboxPathValue === "") return { path: "", ok: false };
  return { path: busyboxPathValue, ok: true };
}

function busyboxAssetForArch(): { name: string; data: Uint8Array } | undefined {
  switch (goarch()) {
    case "amd64":
      return {
        name: "busybox64u.exe",
        data: Deno.readFileSync(
          new URL("./busybox_assets/busybox64u.exe", import.meta.url),
        ),
      };
    case "386":
      return {
        name: "busybox32u.exe",
        data: Deno.readFileSync(
          new URL("./busybox_assets/busybox32u.exe", import.meta.url),
        ),
      };
    default:
      return undefined;
  }
}

function ensureWindowsBusyboxPath(): string {
  const asset = busyboxAssetForArch();
  if (asset === undefined) return "";

  const dir = path.join(configDir(), "bin");
  Deno.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, asset.name);
  try {
    const info = Deno.statSync(target);
    if (info.isDirectory) {
      throw new Error(`busybox path is a directory: ${target}`);
    }
    return target;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  const tmp = Deno.makeTempFileSync({ dir, prefix: ".busybox-" });
  try {
    Deno.writeFileSync(tmp, asset.data);
    Deno.chmodSync(tmp, 0o755);
    Deno.renameSync(tmp, target);
  } finally {
    try {
      Deno.removeSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
  }
  return target;
}
