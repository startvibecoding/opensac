import { assert, assertEquals } from "@opensac/assert";
import {
  cloneCategories,
  cloneSearchPage,
  cloneSkillDetail,
  createMemoryCache,
} from "./cache.ts";
import type {
  Category,
  SearchPage,
  SkillDetail,
  SkillSummary,
} from "./types.ts";

function summary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    market: "skillhub.cn",
    id: "skill-1",
    slug: "skill-1",
    name: "skill-1",
    displayName: "Skill One",
    description: "first",
    version: "1.0.0",
    author: "author",
    category: "tools",
    ...overrides,
  };
}

function page(): SearchPage {
  return {
    items: [summary(), summary({ id: "skill-2", slug: "skill-2" })],
    total: 2,
    page: 1,
  };
}

Deno.test("memory cache round-trips pages, details, and categories", () => {
  const cache = createMemoryCache(60_000);
  cache.setPage("q", page());
  cache.setDetail("d", summary({ id: "detail-1" }) as SkillDetail);
  cache.setCategories("c", [{ key: "tools", name: "Tools" }]);

  assertEquals(cache.getPage("q")?.items.length, 2);
  assertEquals(cache.getDetail("d")?.id, "detail-1");
  assertEquals(cache.getCategories("c")?.[0].key, "tools");
  assertEquals(cache.getPage("missing"), undefined);
  assertEquals(cache.getDetail("missing"), undefined);
  assertEquals(cache.getCategories("missing"), undefined);
});

Deno.test("memory cache expires entries at the configured ttl", () => {
  const expired = createMemoryCache(0);
  expired.setPage("q", page());
  assertEquals(expired.getPage("q"), undefined, "ttl 0 means already expired");

  const live = createMemoryCache(60_000);
  live.setPage("q", page());
  assertEquals(live.getPage("q")?.items.length, 2);
  live.clear();
  assertEquals(live.getPage("q"), undefined);
});

Deno.test("memory cache stores clones so callers cannot mutate the cache", () => {
  const cache = createMemoryCache(60_000);
  const source = page();
  cache.setPage("q", source);

  source.items.pop();
  source.items[0].displayName = "mutated-source";
  source.total = 999;

  const cached = cache.getPage("q");
  assertEquals(cached?.items.length, 2, "mutating the source must not stick");
  assertEquals(cached?.items[0].displayName, "Skill One");
  assertEquals(cached?.total, 2);

  const readBack = cache.getPage("q");
  assert(readBack);
  readBack.items.pop();
  readBack.items[0].displayName = "mutated-read";
  const again = cache.getPage("q");
  assertEquals(again?.items.length, 2, "mutating a read must not stick");
  assertEquals(again?.items[0].displayName, "Skill One");
});

Deno.test("cloneSearchPage deep-clones nested tags and installed state", () => {
  const original: SearchPage = {
    items: [summary({
      tags: ["a", "b"],
      installed: { installed: true, scope: "project", dir: "/tmp/x" },
    })],
  };
  const cloned = cloneSearchPage(original);
  cloned.items[0].tags?.push("c");
  cloned.items[0].installed!.dir = "/tmp/other";

  assertEquals(original.items[0].tags, ["a", "b"]);
  assertEquals(original.items[0].installed?.dir, "/tmp/x");
});

Deno.test("cloneCategories deep-clones nested children", () => {
  const original: Category[] = [{
    key: "root",
    name: "Root",
    children: [{ key: "child", name: "Child" }],
  }];
  const cloned = cloneCategories(original);
  cloned[0].children?.push({ key: "extra", name: "Extra" });
  cloned[0].children![0].name = "mutated";

  assertEquals(original[0].children?.length, 1);
  assertEquals(original[0].children?.[0].name, "Child");
  assert(cloned[0].children !== original[0].children);
});

Deno.test("cloneSkillDetail clones files and download sources", () => {
  const detail: SkillDetail = {
    ...summary(),
    files: [{ path: "SKILL.md", size: 10 }],
    downloadSources: [{ url: "https://example.com/a.zip", kind: "zip" }],
  };
  const cloned = cloneSkillDetail(detail);
  cloned.files?.push({ path: "extra.md" });
  cloned.downloadSources![0].url = "https://evil.example.com";

  assertEquals(detail.files?.length, 1);
  assertEquals(
    detail.downloadSources?.[0].url,
    "https://example.com/a.zip",
  );
  assert(cloned.files !== detail.files);
});
