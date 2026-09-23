// (bwrap cases).

import { assert, assertEquals } from "@std/assert";
import {
  bwrapCapabilitiesComplete,
  findBwrap,
  Level,
  newBwrapSandbox,
  newBwrapSandboxWithOptions,
  probeBwrapCapabilities,
} from "./mod.ts";

function indexArgs(args: string[], ...seq: string[]): number {
  for (let i = 0; i + seq.length <= args.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (args[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

Deno.test("newBwrapSandbox name and level", () => {
  const sb = newBwrapSandbox("/tmp", Level.Standard);
  assertEquals(sb.name(), "bwrap");
  assertEquals(sb.level(), Level.Standard);

  const strict = newBwrapSandbox("/tmp", Level.Strict);
  assertEquals(strict.name(), "bwrap");
  assertEquals(strict.level(), Level.Strict);
});

Deno.test("bwrapCapabilities require every runtime flag", () => {
  const caps = {
    unshareUser: true,
    unsharePid: true,
    unshareIpc: true,
    unshareUts: true,
    newSession: true,
    dieWithParent: true,
    mountProc: true,
    mountDev: true,
    mountTmpfs: true,
    tmpfsSize: true,
    mountBind: true,
    changeDir: true,
    hostname: true,
  };
  assert(bwrapCapabilitiesComplete(caps));
  assert(!bwrapCapabilitiesComplete({ ...caps, hostname: false }));
});

Deno.test("probeBwrapCapabilities missing path", () => {
  const { caps, ok } = probeBwrapCapabilities("/definitely/missing/bwrap");
  assert(!ok);
  assert(!bwrapCapabilitiesComplete(caps));
});

Deno.test("probeBwrapCapabilities real binary", () => {
  const path = findBwrap();
  if (path === "") return; // bwrap unavailable
  const { caps, ok } = probeBwrapCapabilities(path);
  assert(ok, "bwrap --help probe failed");
  assert(
    bwrapCapabilitiesComplete(caps),
    "bwrap missing required capabilities",
  );
});

Deno.test("bwrap args use complete isolation profile", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = newBwrapSandboxWithOptions(project, Level.Standard, {
    tmpSize: "4096",
  });
  const args = sb.buildBwrapArgs(
    sb.options,
    { workDir: project },
    "/bin/sh",
    "hostname && ps",
  );

  for (
    const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      "--die-with-parent",
      "--proc",
      "--dev",
      "--size",
      "--tmpfs",
      "--hostname",
      "--chdir",
    ]
  ) {
    assert(indexArgs(args, flag) >= 0, `missing ${flag} in bwrap profile`);
  }
  assert(indexArgs(args, "--size", "4096", "--tmpfs", "/tmp") >= 0);
  assert(indexArgs(args, "--hostname", "sandbox") >= 0);
  assert(indexArgs(args, "--chdir", project) >= 0);
});

Deno.test("bwrap args do not rebind dev devices", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = newBwrapSandboxWithOptions(project, Level.Standard, {
    allowedRead: ["/dev/null", "/dev/urandom", "/etc/ssl"],
  });
  const args = sb.buildBwrapArgs(
    sb.options,
    { workDir: project },
    "/bin/sh",
    "git status",
  );
  assertEquals(indexArgs(args, "--ro-bind", "/dev/null", "/dev/null"), -1);
  assertEquals(
    indexArgs(args, "--ro-bind", "/dev/urandom", "/dev/urandom"),
    -1,
  );
  assert(indexArgs(args, "--ro-bind", "/etc/ssl", "/etc/ssl") >= 0);
});

Deno.test("bwrap normalizes human readable tmpSize", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = newBwrapSandboxWithOptions(project, Level.Standard, {
    tmpSize: "100m",
  });
  const args = sb.buildBwrapArgs(
    sb.options,
    { workDir: project },
    "/bin/sh",
    "true",
  );
  assert(indexArgs(args, "--size", "104857600", "--tmpfs", "/tmp") >= 0);
  assertEquals(indexArgs(args, "--size", "100m"), -1);
});

Deno.test("bwrap args preserve host network", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const forOpts = (networkAccess: boolean) =>
    newBwrapSandbox(project, Level.Standard).buildBwrapArgs(
      {},
      { workDir: project, networkAccess },
      "/bin/sh",
      "true",
    );
  for (const opts of [forOpts(false), forOpts(true)]) {
    assertEquals(indexArgs(opts, "--unshare-net"), -1);
  }
});

Deno.test("bwrap wrapCommand returns a command spec", () => {
  const sb = newBwrapSandbox("/tmp", Level.Standard);
  const spec = sb.wrapCommand(undefined, "/bin/bash", "echo hello", {
    workDir: "/tmp",
    envVars: { FOO: "bar" },
  });
  assertEquals(spec.cwd, "/tmp");
  assert(spec.args.length > 0);
  assert(spec.args.includes("--setenv"));
});

Deno.test("bwrap strict level binds project read-only", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = newBwrapSandbox(project, Level.Strict);
  const args = sb.buildBwrapArgs(
    sb.options,
    { workDir: project },
    "/bin/sh",
    "ls",
  );
  assert(indexArgs(args, "--ro-bind", project, project) >= 0);
  assertEquals(indexArgs(args, "--bind", project, project), -1);
});
