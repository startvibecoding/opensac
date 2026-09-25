import { assertEquals, assertThrows } from "@std/assert";
import { defaultCoreConfig, resolveCoreConfig } from "./config.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";

function settingsWithCore(core: unknown): Settings {
  return {
    ...defaultSettings(),
    core,
  } as unknown as Settings;
}

Deno.test("core configuration defaults", () => {
  assertEquals(defaultCoreConfig(), {
    host: "127.0.0.1",
    port: 4096,
    auth: false,
    passwords: [],
  });
  assertEquals(resolveCoreConfig(defaultSettings()), {
    host: "127.0.0.1",
    port: 4096,
    auth: false,
    passwords: [],
  });
});

Deno.test("core configuration resolves explicit values and partial defaults", () => {
  assertEquals(
    resolveCoreConfig(settingsWithCore({
      host: "0.0.0.0",
      port: 0,
      auth: true,
      passwords: ["one", "two"],
    })),
    {
      host: "0.0.0.0",
      port: 0,
      auth: true,
      passwords: ["one", "two"],
    },
  );
  assertEquals(
    resolveCoreConfig(settingsWithCore({ port: 4310 })),
    {
      host: "127.0.0.1",
      port: 4310,
      auth: false,
      passwords: [],
    },
  );
});

Deno.test("core configuration rejects invalid values", () => {
  for (
    const core of [
      { host: 123 },
      { host: null },
      { port: -1 },
      { port: 65536 },
      { port: 1.5 },
      { port: "4096" },
      { port: null },
      { auth: "true" },
      { auth: 1 },
      { auth: null },
      { passwords: "secret" },
      { passwords: null },
      { passwords: [123] },
      { auth: true, passwords: [] },
    ]
  ) {
    assertThrows(() => resolveCoreConfig(settingsWithCore(core)));
  }
});

Deno.test("core configuration copies password arrays", () => {
  const passwords = ["secret"];
  const resolved = resolveCoreConfig(settingsWithCore({
    auth: true,
    passwords,
  }));

  passwords.push("later");
  resolved.passwords[0] = "changed";
  assertEquals(passwords, ["secret", "later"]);
  assertEquals(resolved.passwords, ["changed"]);
});
