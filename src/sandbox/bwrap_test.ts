// (bwrap cases).

import { assert, assertEquals } from "../compat/assert.ts";
import {
  bwrapCapabilitiesComplete,
  createBwrapSandbox,
  findBwrap,
  Level,
  probeBwrapCapabilities,
} from "./mod.ts";
import { test } from "#testing";

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

test("createBwrapSandbox name and level", () => {
  const sb = createBwrapSandbox("/tmp", Level.Standard);
  assertEquals(sb.name(), "bwrap");
  assertEquals(sb.level(), Level.Standard);

  const strict = createBwrapSandbox("/tmp", Level.Strict);
  assertEquals(strict.name(), "bwrap");
  assertEquals(strict.level(), Level.Strict);
});

test("bwrapCapabilities require every runtime flag", () => {
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

test("probeBwrapCapabilities missing path", () => {
  const caps = probeBwrapCapabilities("/definitely/missing/bwrap");
  assert(caps === undefined);
});

test("probeBwrapCapabilities real binary", () => {
  const path = findBwrap();
  if (path === "") return; // bwrap unavailable
  const caps = probeBwrapCapabilities(path);
  assert(caps !== undefined, "bwrap --help probe failed");
  assert(
    bwrapCapabilitiesComplete(caps),
    "bwrap missing required capabilities",
  );
});

test("bwrap args use complete isolation profile", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = createBwrapSandbox(project, Level.Standard, {
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

test("bwrap args do not rebind dev devices", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = createBwrapSandbox(project, Level.Standard, {
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

test("bwrap normalizes human readable tmpSize", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = createBwrapSandbox(project, Level.Standard, {
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

test("bwrap args preserve host network", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const forOpts = (networkAccess: boolean) =>
    createBwrapSandbox(project, Level.Standard).buildBwrapArgs(
      {},
      { workDir: project, networkAccess },
      "/bin/sh",
      "true",
    );
  for (const opts of [forOpts(false), forOpts(true)]) {
    assertEquals(indexArgs(opts, "--unshare-net"), -1);
  }
});

test("bwrap wrapCommand returns a command spec", () => {
  const sb = createBwrapSandbox("/tmp", Level.Standard);
  const spec = sb.wrapCommand(undefined, "/bin/bash", "echo hello", {
    workDir: "/tmp",
    envVars: { FOO: "bar" },
  });
  assertEquals(spec.cwd, "/tmp");
  assert(spec.args.length > 0);
  assert(spec.args.includes("--setenv"));
});

test("bwrap strict level binds project read-only", () => {
  const project = Deno.makeTempDirSync({ prefix: "sbx-" });
  const sb = createBwrapSandbox(project, Level.Strict);
  const args = sb.buildBwrapArgs(
    sb.options,
    { workDir: project },
    "/bin/sh",
    "ls",
  );
  assert(indexArgs(args, "--ro-bind", project, project) >= 0);
  assertEquals(indexArgs(args, "--bind", project, project), -1);
});
