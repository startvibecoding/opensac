import { assertEquals } from "@opensac/assert";
import * as path from "@opensac/path";
import { LocalIndex } from "./local.ts";
import { Service } from "./service.ts";
import { CountingClient, emptyDetail } from "./test_helpers.ts";
import type { SkillSummary } from "./types.ts";

Deno.test("LocalIndexIncludesAndMergesLocalSkill", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(path.join(root, "handmade"), { recursive: true });
  await Deno.writeTextFile(
    path.join(root, "handmade", "SKILL.md"),
    "# Handmade",
  );
  const index = new LocalIndex("", [root]);
  const entries = index.list();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].local, true);
  assertEquals(entries[0].name, "handmade");

  const items: SkillSummary[] = [{
    ...emptyDetail(),
    market: "skillhub.cn",
    id: "handmade",
    slug: "handmade",
  }];
  index.apply(items);
  assertEquals(items[0].installed?.local, true);
});

Deno.test("ServiceCachesSearch", async () => {
  const client = new CountingClient();
  const service = new Service(await Deno.makeTempDir(), [], [], client);
  await service.search(undefined, "skillhub.cn", { limit: 1 });
  await service.search(undefined, "skillhub.cn", { limit: 1 });
  assertEquals(client.searches, 1);
});
