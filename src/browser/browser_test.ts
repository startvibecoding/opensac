// for the ported protocol/client surface.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { Image } from "imagescript";
import { createManager } from "../skills/mod.ts";
import { createRegistry } from "../tools/tool.ts";
import {
  clientOptions,
  cookieFromParams,
  createTool,
  htmlOptionsFromParams,
  isToolRegistered,
  registerTool,
  removeTool,
  SKILL_NAME,
} from "./mod.ts";
import { formatAxTree, runeAlignedPrefix, truncateHtml } from "./ops.ts";
import { test } from "#testing";

async function testPng(width: number, height: number): Promise<Uint8Array> {
  const img = new Image(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.bitmap[i] = x % 255;
      img.bitmap[i + 1] = y % 255;
      img.bitmap[i + 2] = 180;
      img.bitmap[i + 3] = 255;
    }
  }
  return await img.encode();
}

test("built-in browser skill is discoverable", () => {
  const manager = createManager("", []);
  manager.load();
  const skill = manager.get(SKILL_NAME);
  assert(skill);
  assertEquals(skill.source, "builtin");
  const context = manager.buildSkillContext(SKILL_NAME);
  for (const want of [
    "# Vibe Browser",
    "`browser` tool",
    "`snapshot`",
    "`screenshot`",
    "Never claim a UI state changed until you verify it",
  ]) {
    assert(
      context.includes(want),
      `skill content missing ${JSON.stringify(want)}`,
    );
  }
});

test("register and remove browser tool", () => {
  const tmp = runtime.makeTempDirSync({ prefix: "browser-" });
  const registry = createRegistry(tmp, undefined);

  registerTool(registry);
  assert(isToolRegistered(registry));

  removeTool(registry);
  assertEquals(isToolRegistered(registry), false);
});

test("screenshot tool result processes image", async () => {
  const tmp = runtime.makeTempDirSync({ prefix: "browser-" });
  const registry = createRegistry(tmp, undefined);
  const tool = createTool(registry);

  const result = await tool.screenshotToolResult(await testPng(200, 100), {
    maxLongEdge: 50,
  });
  assertEquals(result.contents?.length, 2);
  const image = result.contents?.[1];
  assert(image && image.type === "image");
  if (!image || image.type !== "image") throw new Error("unreachable");
  const img = image.image;
  assert(img);
  if (!img) throw new Error("unreachable");
  assertEquals(img.width, 50);
  assertEquals(img.height, 25);
  assertEquals(img.originalWidth, 200);
  assertEquals(img.originalHeight, 100);
  assertEquals(img.detail, "detail");
  assert(result.text.includes("Browser screenshot"));
  assert(result.text.includes("original: 200x100"));
});

test("client options default launch viewport", () => {
  const opts = clientOptions({});
  assert(opts.launch);
  assertEquals(opts.launch.viewportWidth, 1920);
  assertEquals(opts.launch.viewportHeight, 1080);
  assertEquals(opts.launch.headless, true);
});

test("client options allow viewport and headless override", () => {
  const opts = clientOptions({
    viewportWidth: 1366,
    viewportHeight: 768,
    headless: false,
  });
  assert(opts.launch);
  assertEquals(opts.launch.viewportWidth, 1366);
  assertEquals(opts.launch.viewportHeight, 768);
  assertEquals(opts.launch.headless, false);
});

test("html options from params", () => {
  assertEquals(htmlOptionsFromParams({ selector: "body" }), undefined);
  assertEquals(htmlOptionsFromParams({ maxBytes: 0 }), {
    maxBytes: 0,
    maxChars: 0,
  });
  assertEquals(htmlOptionsFromParams({ maxBytes: 100000 }), {
    maxBytes: 100000,
    maxChars: 0,
  });
  assertEquals(htmlOptionsFromParams({ maxChars: 5000 }), {
    maxBytes: 0,
    maxChars: 5000,
  });
  assertEquals(htmlOptionsFromParams({ maxBytes: 0, maxChars: 100 }), {
    maxBytes: 0,
    maxChars: 100,
  });
});

test("cookie from params", () => {
  const c = cookieFromParams({
    name: "session",
    value: "abc",
    domain: "example.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: 1700000000,
  });
  assertEquals(c.name, "session");
  assertEquals(c.value, "abc");
  assertEquals(c.domain, "example.com");
  assertEquals(c.path, "/");
  assertEquals(c.httpOnly, true);
  assertEquals(c.secure, true);
  assertEquals(c.sameSite, "Lax");
  assertEquals(c.expires, 1700000000);
});

test("truncateHtml caps by bytes and chars", () => {
  const short = "hello";
  assertEquals(truncateHtml(short), short);

  const big = "a".repeat(1000);
  const byteCapped = truncateHtml(big, { maxBytes: 100 });
  assert(byteCapped.length <= 100);
  assert(byteCapped.includes("[truncated:"));

  const noCap = truncateHtml(big, { maxBytes: 0 });
  assertEquals(noCap, big);

  const charCapped = truncateHtml("abcdef", { maxChars: 3 });
  assert(charCapped.startsWith("abc"));
});

test("runeAlignedPrefix never splits multibyte runes", () => {
  const s = "a本b"; // a=1 byte, 本=3 bytes, b=1 byte
  assertEquals(runeAlignedPrefix(s, 0), "");
  assertEquals(runeAlignedPrefix(s, 1), "a");
  assertEquals(runeAlignedPrefix(s, 3), "a");
  assertEquals(runeAlignedPrefix(s, 4), "a本");
  assertEquals(runeAlignedPrefix(s, 100), s);
});

test("formatAxTree renders roles, refs, and interactive filter", () => {
  const nodes = [
    {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "Doc" },
      childIds: ["2", "3"],
    },
    {
      nodeId: "2",
      role: { value: "button" },
      name: { value: "Submit" },
      childIds: [],
      properties: [{ name: "disabled", value: { value: true } }],
    },
    {
      nodeId: "3",
      role: { value: "StaticText" },
      name: { value: "hello" },
      childIds: [],
    },
  ];
  const full = formatAxTree(nodes);
  assert(full.includes("RootWebArea Doc"));
  assert(full.includes("[1] button Submit [disabled]"));

  const interactive = formatAxTree(nodes, { interactive: true });
  assert(interactive.includes("button Submit"));
  assertEquals(interactive.includes("StaticText"), false);

  const empty = formatAxTree([]);
  assertEquals(empty, "(empty page)");
});
