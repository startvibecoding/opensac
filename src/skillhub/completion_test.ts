import { runtime } from "../platform/runtime.ts";
import { assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { LocalIndex } from "./local.ts";
import { Service } from "./service.ts";
import { CountingClient, emptyDetail } from "./test_helpers.ts";
import { type SkillSummary } from "./types.ts";
import { test } from "#testing";

test("LocalIndexIncludesAndMergesLocalSkill", async () => {
  const root = await runtime.makeTempDir();
  await runtime.mkdir(path.join(root, "handmade"), { recursive: true });
  await runtime.writeTextFile(
    path.join(root, "handmade", "SKILL.md"),
    "# Handmade",
  );
  const index = new LocalIndex("", [root]);
  const entries = index.list();
  assertEquals(entries.length, 1);
  assertEquals(entries[0].local, true);
  assertEquals(entries[0].name, "handmade");

  const items: SkillSummary[] = [
    {
      ...emptyDetail(),
      market: "skillhub.cn",
      id: "handmade",
      slug: "handmade",
    },
  ];
  index.apply(items);
  assertEquals(items[0].installed?.local, true);
});

test("ServiceCachesSearch", async () => {
  const client = new CountingClient();
  const service = new Service(await runtime.makeTempDir(), [], [], client);
  await service.search(undefined, "skillhub.cn", { limit: 1 });
  await service.search(undefined, "skillhub.cn", { limit: 1 });
  assertEquals(client.searches, 1);
});
