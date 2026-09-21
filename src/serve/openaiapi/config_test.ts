// Translated from internal/serve/openaiapi/server_test.go's config cases
// (TestDefaultConfig, TestValidateListenSecurity, TestGetWorkDirPrefersDefaultWorkDir,
// TestValidateWorkDir, TestValidateWorkDirRejectsSymlinkEscape, TestCloneConfig,
// TestToolVisibility_DefaultDetail).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyUnsafeAccess,
  cloneConfig,
  defaultConfig,
  getListenAddr,
  getToolDetail,
  getWorkDir,
  normalizeConfig,
  unsafeListenAddr,
  validateListenSecurity,
  validateWorkDir,
} from "./config.ts";

Deno.test("defaultConfig matches the Go defaults", () => {
  const cfg = defaultConfig();
  assertEquals(cfg.listen, "127.0.0.1:7872");
  assertEquals(cfg.defaultMode, "yolo");
  assertEquals(cfg.toolVisibility!.mode, "content");
  assertEquals(cfg.systemPromptMode, "append");
  assertEquals(cfg.requestTimeoutSecs, 1800);
  assert(!cfg.sandbox!.enabled);
  assert(!cfg.enableArtifact);
});

Deno.test("validateListenSecurity table", () => {
  const tests = [
    {
      name: "loopback without auth",
      listen: "127.0.0.1:8080",
      enabled: false,
      tokens: [] as string[],
      unsafe: false,
      wantErr: false,
    },
    {
      name: "localhost without auth",
      listen: "localhost:8080",
      enabled: false,
      tokens: [],
      unsafe: false,
      wantErr: false,
    },
    {
      name: "public without auth",
      listen: "0.0.0.0:8080",
      enabled: false,
      tokens: [],
      unsafe: false,
      wantErr: true,
    },
    {
      name: "wildcard without auth",
      listen: ":8080",
      enabled: false,
      tokens: [],
      unsafe: false,
      wantErr: true,
    },
    {
      name: "public with auth",
      listen: "0.0.0.0:8080",
      enabled: true,
      tokens: ["token"],
      unsafe: false,
      wantErr: false,
    },
    {
      name: "public unsafe",
      listen: "0.0.0.0:8080",
      enabled: false,
      tokens: [],
      unsafe: true,
      wantErr: false,
    },
  ];
  for (const tt of tests) {
    let failed = false;
    try {
      validateListenSecurity(
        { auth: { enabled: tt.enabled, tokens: tt.tokens }, listen: tt.listen },
        tt.unsafe,
      );
    } catch {
      failed = true;
    }
    assertEquals(failed, tt.wantErr, tt.name);
  }
});

Deno.test("getWorkDir prefers defaultWorkDir", () => {
  const cfg = {
    auth: { enabled: false },
    defaultWorkDir: "/tmp/default",
    workingDir: "/tmp/legacy",
  };
  assertEquals(getWorkDir(cfg), "/tmp/default");

  cfg.defaultWorkDir = "";
  assertEquals(getWorkDir(cfg), "/tmp/legacy");
});

Deno.test("validateWorkDir table", async () => {
  const tests = [
    {
      name: "nil=no check",
      allowed: undefined,
      dir: "/any/path",
      wantErr: false,
    },
    { name: "empty=deny all", allowed: [], dir: "/any/path", wantErr: true },
    {
      name: "exact match",
      allowed: ["/home/user/projects"],
      dir: "/home/user/projects",
      wantErr: false,
    },
    {
      name: "prefix match",
      allowed: ["/home/user/projects"],
      dir: "/home/user/projects/foo",
      wantErr: false,
    },
    {
      name: "evil prefix",
      allowed: ["/home/user/projects"],
      dir: "/home/user/projects-evil",
      wantErr: true,
    },
    {
      name: "no match",
      allowed: ["/opt/repos"],
      dir: "/home/user/projects",
      wantErr: true,
    },
    {
      name: "multi allowed",
      allowed: ["/opt/repos", "/home/user"],
      dir: "/home/user/foo",
      wantErr: false,
    },
  ];
  for (const tt of tests) {
    const cfg = { auth: { enabled: false }, allowedWorkDirs: tt.allowed };
    const outcome = validateWorkDir(cfg, tt.dir);
    if (tt.wantErr) {
      await assertRejects(() => outcome);
    } else {
      await outcome;
    }
  }
});

Deno.test("validateWorkDir rejects symlink escape", async () => {
  const allowedDir = await Deno.makeTempDir();
  const outsideDir = await Deno.makeTempDir();
  const link = `${allowedDir}/outside`;
  try {
    await Deno.symlink(outsideDir, link);
  } catch {
    return; // symlink unsupported: Go skips too
  }
  const cfg = { auth: { enabled: false }, allowedWorkDirs: [allowedDir] };
  await assertRejects(() => validateWorkDir(cfg, `${link}/new-session`));
});

Deno.test("cloneConfig deep-copies shared slices", () => {
  const cfg: ReturnType<typeof defaultConfig> = {
    ...defaultConfig(),
    listen: ":8080",
    auth: { enabled: true, tokens: ["sk-a", "sk-b"] },
    cors: { enabled: true, allowOrigins: ["http://localhost:3000"] },
    allowedWorkDirs: ["/home/test", "/opt/repos"],
  };

  const clone = cloneConfig(cfg)!;
  assert(clone !== cfg);

  clone.listen = ":9090";
  clone.auth!.tokens![0] = "sk-mutated";
  clone.cors!.allowOrigins![0] = "http://mutated";
  clone.allowedWorkDirs![0] = "/tmp/mutated";

  assertEquals(cfg.listen, ":8080");
  assertEquals(cfg.auth!.tokens![0], "sk-a");
  assertEquals(cfg.cors!.allowOrigins![0], "http://localhost:3000");
  assertEquals(cfg.allowedWorkDirs![0], "/home/test");
});

Deno.test("tool visibility default detail", () => {
  const cfg = defaultConfig();
  assertEquals(getToolDetail(cfg), "collapsed");
});

Deno.test("unsafe listen address forms", () => {
  assertEquals(unsafeListenAddr("127.0.0.1:8080"), "0.0.0.0:8080");
  assertEquals(unsafeListenAddr("localhost:8080"), "0.0.0.0:8080");
  assertEquals(unsafeListenAddr(":8080"), "0.0.0.0:8080");
  assertEquals(unsafeListenAddr("8080"), "0.0.0.0:8080");
  assertEquals(unsafeListenAddr("example.com:8080"), "example.com:8080");
  assertEquals(unsafeListenAddr(""), "0.0.0.0:7872");
});

Deno.test("applyUnsafeAccess disables auth and rewrites loopback listen", () => {
  const cfg = defaultConfig();
  cfg.listen = "127.0.0.1:7872";
  cfg.auth = { enabled: true, tokens: ["sk-a"] };
  applyUnsafeAccess(cfg);
  assertEquals(cfg.auth.enabled, false);
  assertEquals(cfg.auth.tokens, undefined);
  assertEquals(getListenAddr(cfg), "0.0.0.0:7872");
});

Deno.test("normalizeConfig fills empty fields", () => {
  const target = defaultConfig();
  target.listen = "";
  target.defaultMode = "";
  target.toolVisibility = {};
  target.systemPromptMode = "";
  target.requestTimeoutSecs = 0;
  normalizeConfig(target);
  assertEquals(target.listen, "127.0.0.1:7872");
  assertEquals(target.defaultMode, "yolo");
  assertEquals(target.toolVisibility.mode, "content");
  assertEquals(target.toolVisibility.detail, "collapsed");
  assertEquals(target.systemPromptMode, "append");
  assertEquals(target.requestTimeoutSecs, 1800);
  assertEquals(getListenAddr(target), "127.0.0.1:7872");
});
