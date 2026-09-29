// The Windows shell policy lives in platform.ts because both the `bash` tool
// and the system prompt must resolve the same shell. These cover the resolver
// policy directly, on any host, by injecting the platform-dependent inputs.

import { assert, assertEquals } from "@std/assert";
import {
  defaultShellForOS,
  isValidShell,
  resolveBashShell,
  resolveShellForOS,
  shellArgs,
} from "./platform.ts";

const BUSYBOX = "C:\\Users\\dev\\.opensac\\bin\\busybox64u.exe";

function resolution(overrides: {
  goos?: string;
  busyboxPath?: string;
  defaultShell?: string;
  shellEnv?: string;
  isValidShell?: (p: string) => boolean;
  configuredShell?: string;
} = {}) {
  return {
    goos: overrides.goos ?? "windows",
    busyboxPath: overrides.busyboxPath ?? "",
    defaultShell: overrides.defaultShell ?? "powershell.exe",
    shellEnv: overrides.shellEnv ?? "",
    isValidShell: overrides.isValidShell ?? (() => true),
    configuredShell: overrides.configuredShell,
  };
}

Deno.test("windows prefers the extracted busybox over the platform default", () => {
  assertEquals(
    resolveShellForOS(resolution({ busyboxPath: BUSYBOX })),
    BUSYBOX,
  );
});

Deno.test("windows falls back to the platform default without busybox", () => {
  assertEquals(
    resolveShellForOS(resolution({ busyboxPath: "" })),
    "powershell.exe",
  );
  assertEquals(
    resolveShellForOS(
      resolution({ busyboxPath: "", defaultShell: "cmd.exe" }),
    ),
    "cmd.exe",
  );
});

Deno.test("windows ignores SHELL so busybox stays authoritative", () => {
  assertEquals(
    resolveShellForOS(
      resolution({ busyboxPath: BUSYBOX, shellEnv: "/bin/bash" }),
    ),
    BUSYBOX,
  );
});

Deno.test("non-windows honors a valid SHELL over the default", () => {
  assertEquals(
    resolveShellForOS(
      resolution({ goos: "linux", shellEnv: "/usr/bin/zsh" }),
    ),
    "/usr/bin/zsh",
  );
});

Deno.test("non-windows rejects an unknown or missing SHELL", () => {
  assertEquals(
    resolveShellForOS(
      resolution({
        goos: "linux",
        defaultShell: "/bin/bash",
        shellEnv: "/opt/weird/thing",
        isValidShell: () => false,
      }),
    ),
    "/bin/bash",
  );
  assertEquals(
    resolveShellForOS(
      resolution({ goos: "linux", defaultShell: "/bin/bash", shellEnv: "" }),
    ),
    "/bin/bash",
  );
});

Deno.test("busybox is invoked with POSIX sh arguments", () => {
  assertEquals(shellArgs(BUSYBOX, "ls -la"), ["sh", "-c", "ls -la"]);
  assertEquals(
    shellArgs("C:\\ops\\busybox32u.exe", "echo hi"),
    ["sh", "-c", "echo hi"],
  );
});

Deno.test("an explicit configured shell outranks every other rule", () => {
  const dir = Deno.makeTempDirSync({ prefix: ".opensac-configured-" });
  try {
    const custom = `${dir}/myshell`;
    Deno.writeTextFileSync(custom, "#!/bin/sh\n");

    // Beats BusyBox on Windows, and beats $SHELL elsewhere.
    assertEquals(
      resolveShellForOS(
        resolution({ busyboxPath: BUSYBOX, configuredShell: custom }),
      ),
      custom,
    );
    assertEquals(
      resolveShellForOS(
        resolution({
          goos: "linux",
          shellEnv: "/usr/bin/zsh",
          configuredShell: custom,
        }),
      ),
      custom,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a configured shell that does not exist falls back", () => {
  // Regression: `settings.shellPath` used to be dead config. It is now honored,
  // but a stale value must not break every command.
  assertEquals(
    resolveShellForOS(
      resolution({
        configuredShell: "/nonexistent/shell/does-not-exist",
        defaultShell: "powershell.exe",
      }),
    ),
    "powershell.exe",
  );
  // An empty configured value is "unset", not "invalid".
  assertEquals(
    resolveShellForOS(
      resolution({ busyboxPath: BUSYBOX, configuredShell: "" }),
    ),
    BUSYBOX,
  );
});

Deno.test("isValidShell accepts a real shell file and rejects other names", () => {
  const dir = Deno.makeTempDirSync({ prefix: ".opensac-shell-" });
  try {
    const shell = `${dir}/bash`;
    Deno.writeTextFileSync(shell, "#!/bin/sh\n");
    Deno.chmodSync(shell, 0o755);
    assert(isValidShell(shell));
    // A real file that is not a known shell name is still rejected.
    Deno.writeTextFileSync(`${dir}/python3`, "");
    assert(!isValidShell(`${dir}/python3`));
    // A known shell name that does not exist is rejected.
    assert(!isValidShell(`${dir}/zsh`));
    // A directory named like a shell is rejected.
    Deno.mkdirSync(`${dir}/ksh`);
    assert(!isValidShell(`${dir}/ksh`));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveBashShell is the single shell the runtime advertises", () => {
  // Whatever the host is, the resolved shell must be one the tool can actually
  // build a command for. This is the invariant the Windows busybox override
  // used to break in the system prompt.
  const shell = resolveBashShell();
  assert(shell !== "", "resolved shell must not be empty");
  const args = shellArgs(shell, "echo hi");
  assert(args.length > 0);
  assert(args.includes("echo hi"));
});

// ── default-shell fallback chain ─────────────────────────────────────────────

/** Builds `defaultShellForOS` lookups over a fixed set of existing files. */
function host(
  goos: string,
  existing: string[],
  onPath: Record<string, string> = {},
) {
  const files = new Set(existing);
  return defaultShellForOS(
    goos,
    (p) => files.has(p),
    (name) => onPath[name] ?? null,
  );
}

Deno.test("default shell prefers bash when it exists", () => {
  assertEquals(
    host("linux", ["/bin/bash", "/bin/zsh", "/bin/sh"]),
    "/bin/bash",
  );
});

Deno.test("default shell falls back zsh, fish, ash, sh when bash is absent", () => {
  // Regression: a host without bash used to jump straight to /bin/sh, so a
  // zsh/fish/ash user silently lost their shell.
  assertEquals(
    host("linux", ["/bin/zsh", "/bin/fish", "/bin/ash", "/bin/sh"]),
    "/bin/zsh",
  );
  assertEquals(
    host("linux", ["/bin/fish", "/bin/ash", "/bin/sh"]),
    "/bin/fish",
  );
  assertEquals(
    host("linux", ["/bin/ash", "/bin/sh"]),
    "/bin/ash",
  );
  assertEquals(host("linux", ["/bin/sh"]), "/bin/sh");
});

Deno.test("default shell also searches /usr/bin", () => {
  // NixOS and HomeBSD-style layouts keep shells in /usr/bin.
  assertEquals(
    host("linux", ["/usr/bin/bash", "/bin/sh"]),
    "/usr/bin/bash",
  );
  assertEquals(
    host("linux", ["/usr/bin/zsh", "/bin/sh"]),
    "/usr/bin/zsh",
  );
});

Deno.test("default shell falls through to a PATH-resolved shell", () => {
  assertEquals(
    host("linux", ["/bin/sh"], { zsh: "/opt/homebrew/bin/zsh" }),
    "/opt/homebrew/bin/zsh",
  );
  // A PATH hit for a higher-priority shell still wins over a lower-priority
  // absolute path.
  assertEquals(
    host("linux", ["/bin/fish", "/bin/sh"], {
      bash: "/nix/store/bash/bin/bash",
    }),
    "/nix/store/bash/bin/bash",
  );
});

Deno.test("default shell returns sh when nothing is installed", () => {
  assertEquals(host("linux", []), "/bin/sh");
  assertEquals(host("freebsd", []), "/bin/sh");
});

Deno.test("macOS keeps zsh ahead of Apple's bash", () => {
  assertEquals(
    host("darwin", ["/bin/zsh", "/bin/bash"]),
    "/bin/zsh",
  );
  // bash is still reached when zsh is absent.
  assertEquals(host("darwin", ["/bin/bash"]), "/bin/bash");
});

Deno.test("windows and plan9 keep their dedicated shells", () => {
  assertEquals(
    host("windows", [], { "powershell.exe": "powershell.exe" }),
    "powershell.exe",
  );
  assertEquals(host("windows", []), "cmd.exe");
  assertEquals(host("plan9", []), "/bin/rc");
});

Deno.test("ash is an accepted explicit SHELL", () => {
  // ash is a first-class fallback, so $SHELL=/bin/ash must not be rejected.
  const dir = Deno.makeTempDirSync({ prefix: ".opensac-ash-" });
  try {
    const ash = `${dir}/ash`;
    Deno.writeTextFileSync(ash, "#!/bin/sh\n");
    assert(isValidShell(ash));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
