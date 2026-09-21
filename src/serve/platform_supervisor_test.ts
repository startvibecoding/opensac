// Ported from internal/serve/platform_supervisor_test.go (the two pure
// supervisor cases; the channelRuntime candidate/startup cases land with the
// run.go slice).

import { assert, assertEquals, assertFalse } from "@std/assert";

import type { Platform } from "../messaging/platform.ts";
import { PlatformSupervisor } from "./platform_supervisor.ts";

class SupervisorTestPlatform implements Platform {
  stopped = false;
  constructor(public readonly platformName: string) {}
  name(): string {
    return this.platformName;
  }
  start(_signal: AbortSignal, _handler: unknown): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {
    this.stopped = true;
  }
  sendMessage(): Promise<void> {
    return Promise.resolve();
  }
  isConnected(): boolean {
    return !this.stopped;
  }
}

Deno.test("PlatformSupervisor RemoveIf does not remove replacement", () => {
  const s = new PlatformSupervisor();
  const old = new SupervisorTestPlatform("wechat");
  const next = new SupervisorTestPlatform("wechat");
  s.replace("wechat", old);
  s.replace("wechat", next);
  assertFalse(s.removeIf("wechat", old), "RemoveIf removed a replacement");
  assertEquals(s.get("wechat"), next, "replacement was not retained");
});

Deno.test("PlatformSupervisor StopAll clears instances", async () => {
  const s = new PlatformSupervisor();
  const wechat = new SupervisorTestPlatform("wechat");
  const feishu = new SupervisorTestPlatform("feishu");
  s.replace("wechat", wechat);
  s.replace("feishu", feishu);
  await s.stopAll();
  assertFalse(
    wechat.isConnected() || feishu.isConnected(),
    "StopAll did not stop every platform",
  );
  assertEquals(s.snapshot().length, 0, "StopAll left instances registered");
});

Deno.test("PlatformSupervisor ReplaceIf guards against stale candidates", () => {
  const s = new PlatformSupervisor();
  const previous = new SupervisorTestPlatform("wechat");
  const late = new SupervisorTestPlatform("wechat");
  s.replace("wechat", previous);
  // A late async result from a superseded candidate must not win.
  assertFalse(s.replaceIf("wechat", late, null));
  assertEquals(s.get("wechat"), previous);
  assert(s.replaceIf("wechat", previous, null));
  assertEquals(s.get("wechat"), undefined);
});
