// Ported from internal/serve/native_directory_picker.go
//
// Delegates directory selection to the operating system. For a local Web UI
// this opens the picker on the same machine as the browser, while keeping the
// selection behavior consistent with Electron.

export const errNativeDirectoryPickerUnavailable = new Error(
  "native directory picker is unavailable",
);

export function openNativeDirectoryPicker(
  signal: AbortSignal,
  defaultPath: string,
): Promise<string> {
  let cleaned = defaultPath;
  try {
    cleaned = normalizePathForPicker(defaultPath);
  } catch {
    cleaned = defaultPath;
  }
  switch (Deno.build.os) {
    case "darwin":
      return openDarwinDirectoryPicker(signal, cleaned);
    case "windows":
      return openWindowsDirectoryPicker(signal, cleaned);
    case "linux":
    case "freebsd":
    case "netbsd":
      return openUnixDirectoryPicker(signal, cleaned);
    default:
      return Promise.reject(errNativeDirectoryPickerUnavailable);
  }
}

/** filepath.Clean equivalent for the picker default path. */
function normalizePathForPicker(p: string): string {
  if (p === "") return ".";
  return normalizeSeparator(p);
}

function normalizeSeparator(p: string): string {
  // @std/path is not needed for the picker's Clean-like behavior: Go's
  // filepath.Clean collapses redundant separators and dot segments.
  const isAbs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  const parts = p.split(/[\\/]/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
        continue;
      }
      if (isAbs) continue;
      out.push("..");
      continue;
    }
    out.push(part);
  }
  let joined = out.join("/");
  if (isAbs) joined = "/" + joined;
  if (p.endsWith("/") || p.endsWith("\\")) {
    if (joined !== "" && !joined.endsWith("/")) joined += "/";
  }
  return joined === "" ? "." : joined;
}

async function openUnixDirectoryPicker(
  signal: AbortSignal,
  defaultPath: string,
): Promise<string> {
  // Native dialogs require a graphical session. On headless servers the
  // picker can never open (and a failed launch is indistinguishable from a
  // cancel), so report it as unavailable and let the Web UI fall back to
  // its built-in directory browser.
  if (
    Deno.env.get("DISPLAY") === "" && Deno.env.get("WAYLAND_DISPLAY") === ""
  ) {
    throw errNativeDirectoryPickerUnavailable;
  }
  let filename = defaultPath;
  if (filename !== "/" && !filename.endsWith("/")) filename += "/";
  const commands: Array<{ name: string; args: string[] }> = [
    {
      name: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Select working directory",
        "--filename=" + filename,
      ],
    },
    {
      name: "kdialog",
      args: [
        "--getexistingdirectory",
        defaultPath,
        "--title",
        "Select working directory",
      ],
    },
    {
      name: "yad",
      args: [
        "--file-selection",
        "--directory",
        "--title=Select working directory",
        "--filename=" + filename,
      ],
    },
  ];
  for (const candidate of commands) {
    if (await lookPath(candidate.name) === undefined) continue;
    return runDirectoryPicker(signal, candidate.name, candidate.args);
  }
  throw errNativeDirectoryPickerUnavailable;
}

async function openDarwinDirectoryPicker(
  signal: AbortSignal,
  defaultPath: string,
): Promise<string> {
  const script = `try
  set selectedFolder to choose folder with prompt "Select working directory" default location POSIX file "${
    appleScriptString(defaultPath)
  }"
  return POSIX path of selectedFolder
on error number -128
  return ""
end try`;
  if (await lookPath("osascript") === undefined) {
    throw errNativeDirectoryPickerUnavailable;
  }
  return runDirectoryPicker(signal, "osascript", ["-e", script]);
}

// windowsDirectoryPickerScript renders the folder picker and writes the
// selection to stdout. Windows PowerShell 5.1 encodes redirected stdout with
// the ANSI/OEM code page (for example GBK on Chinese systems), which corrupts
// non-ASCII paths such as Chinese or full-width directory names; the host
// side always reads the output as UTF-8, so force UTF-8 first. pwsh 7 already
// defaults to UTF-8 for redirected output, and the explicit assignment keeps
// both hosts identical. The default path is passed through an environment
// variable because the process environment block is UTF-16 on Windows.
export const windowsDirectoryPickerScript =
  `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select working directory'
$dialog.SelectedPath = $env:OPENSAC_DIRECTORY_PICKER_PATH
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }`;

async function openWindowsDirectoryPicker(
  signal: AbortSignal,
  defaultPath: string,
): Promise<string> {
  for (const name of ["powershell.exe", "pwsh.exe"]) {
    if (await lookPath(name) === undefined) continue;
    return runDirectoryPickerCommand(signal, name, [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; " +
      windowsDirectoryPickerScript,
    ], { OPENSAC_DIRECTORY_PICKER_PATH: defaultPath });
  }
  throw errNativeDirectoryPickerUnavailable;
}

export function runDirectoryPicker(
  signal: AbortSignal,
  name: string,
  args: string[],
): Promise<string> {
  return runDirectoryPickerCommand(signal, name, args);
}

export async function runDirectoryPickerCommand(
  signal: AbortSignal,
  name: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<string> {
  const command = new Deno.Command(name, {
    args,
    env: extraEnv,
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  let output;
  try {
    output = await command.output();
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? err;
    throw new Error(`native directory picker: ${(err as Error).message}`);
  }
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    if (signal.aborted) throw signal.reason ?? new Error("picker aborted");
    // Native pickers use a non-zero exit status for an ordinary cancel,
    // which stays silent. Launch failures (for example a missing
    // graphical session) print diagnostics on stderr, so they surface as
    // errors instead of being mistaken for a cancel.
    if (stdout.trim() === "" && stderr.trim() === "") return "";
    throw new Error(
      `native directory picker: exit status ${output.code}`,
    );
  }
  // Strip only the trailing newline that picker tools append. Trimming all
  // Unicode whitespace would corrupt legitimate directory names that start
  // or end with a space or a full-width space (U+3000), which NTFS and Unix
  // filesystems both allow.
  return stdout.replace(/[\r\n]+$/, "");
}

export function appleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

/**
 * exec.LookPath equivalent: searches PATH for an executable file. Returns the
 * resolved path or undefined.
 */
export async function lookPath(name: string): Promise<string | undefined> {
  if (name.includes("/")) {
    return (await isExecutableFile(name)) ? name : undefined;
  }
  const pathEnv = Deno.env.get("PATH") ?? "";
  const separator = Deno.build.os === "windows" ? ";" : ":";
  for (const dir of pathEnv.split(separator)) {
    if (dir === "") continue;
    const candidate = `${dir}/${name}`;
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(p);
    return stat.isFile;
  } catch {
    return false;
  }
}
