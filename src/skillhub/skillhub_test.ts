import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { createClawHubClient } from "./clawhub.ts";
import {
  installSkill,
  InvalidArchiveError,
  LocalSkillExistsError,
  writeMetadata,
} from "./install.ts";
import { LocalIndex, readMetadata } from "./local.ts";
import { Service } from "./service.ts";
import { createSkillHubClient } from "./skillhubcn.ts";
import {
  emptyDetail,
  fakeHttpClient,
  FakeMarketClient,
  jsonResponse,
  makeArchive,
} from "./test_helpers.ts";
import { type MarketClient, type SkillSummary } from "./types.ts";
import { test } from "#testing";

test("SkillHubSearchAndUserSkills", async () => {
  const client = fakeHttpClient((url) => {
    const u = new URL(url);
    switch (u.pathname) {
      case "/api/v1/search":
        assertEquals(u.searchParams.get("q"), "go");
        return jsonResponse(
          `{"results":[{"slug":"go-expert","name":"Go Expert","owner_name":"opensac","updatedAt":1783990604537}]}`,
        );
      case "/api/v1/users/opensac/skills":
        assertEquals(u.searchParams.get("page"), "2");
        return jsonResponse(
          `{"count":2,"skills":[{"slug":"go-expert","name":"Go Expert","description":"Go testing"},{"slug":"rust","name":"Rust"}]}`,
        );
      default:
        return jsonResponse("not found", 404, "Not Found");
    }
  });
  const market = createSkillHubClient("https://api.test", client);
  const page = await market.search(undefined, { query: "go", limit: 10 });
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].market, "skillhub.cn");
  assertEquals(page.items[0].author, "opensac");

  const page2 = await market.userSkills(undefined, "opensac", {
    query: "testing",
    limit: 20,
    page: 2,
  });
  assertEquals(page2.items.length, 1);
  assertEquals(page2.items[0].id, "go-expert");
});

test("SkillHubDetailAcceptsCurrentVersionTagsAndStatsShape", async () => {
  const client = fakeHttpClient(() =>
    jsonResponse(
      `{"latestVersion":{"version":"1.0.0","createdAt":1774758863165},"owner":{"displayName":"claudiodrusus","handle":"claudiodrusus"},"skill":{"slug":"skill-1","displayName":"Skill 1","summary":"Generate QR codes","tags":{"latest":"1.0.0"},"stats":{"downloads":1238,"installs":43,"stars":2}}}`,
    )
  );
  const detail = await createSkillHubClient("https://api.test", client).detail(
    undefined,
    { market: "skillhub.cn", id: "skill-1" },
  );
  assertEquals(detail.version, "1.0.0");
  assertEquals(detail.name, "Skill 1");
  assertEquals(detail.downloads, 1238);
  assertEquals(detail.installs, 43);
  assertEquals(detail.stars, 2);
  assertEquals(detail.tags, ["latest=1.0.0"]);
});

test("ClawHubSearchUsesCursorAndNormalizes", async () => {
  const client = fakeHttpClient((url) => {
    const u = new URL(url);
    assertEquals(u.pathname, "/api/v1/skills");
    assertEquals(u.searchParams.get("cursor"), "next");
    assertEquals(u.searchParams.get("author"), "openclaw");
    return jsonResponse(
      `{"items":[{"id":"openclaw/git","name":"Git","summary":"git helpers","latestVersion":"2.0.0","owner":"openclaw","updatedAt":"2026-07-14T10:00:00Z"}],"nextCursor":"later"}`,
    );
  });
  const page = await createClawHubClient("https://api.test", client).search(
    undefined,
    { limit: 10, cursor: "next", author: "openclaw" },
  );
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].id, "openclaw/git");
  assertEquals(page.items[0].version, "2.0.0");
  assertEquals(page.nextCursor, "later");
});

test("ClawHubFullTextSearchUsesSearchEndpointAndOwnerRef", async () => {
  const client = fakeHttpClient((url) => {
    const u = new URL(url);
    assertEquals(u.pathname, "/api/v1/search");
    assertEquals(u.searchParams.get("q"), "photo");
    return jsonResponse(
      `{"results":[{"slug":"photo","displayName":"Photo","summary":"Imaging","downloads":1266,"updatedAt":1778491780967,"ownerHandle":"agistack","owner":{"displayName":"AGIstack"}}]}`,
    );
  });
  const page = await createClawHubClient("https://api.test", client).search(
    undefined,
    { query: "photo", limit: 3 },
  );
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].id, "@agistack/photo");
  assertEquals(page.items[0].author, "AGIstack");
  assertEquals(page.items[0].downloads, 1266);
});

test("ClawHubDetailAcceptsRootObject", async () => {
  const client = fakeHttpClient((url) => {
    assertEquals(new URL(url).pathname, "/api/v1/skills/openclaw/git");
    return jsonResponse(
      `{"id":"openclaw/git","name":"Git","version":"1.0.0","author":"openclaw"}`,
    );
  });
  const detail = await createClawHubClient("https://api.test", client).detail(
    undefined,
    { market: "clawhub.ai", id: "openclaw/git" },
  );
  assertEquals(detail.id, "openclaw/git");
  assertEquals(detail.version, "1.0.0");
});

test("ClawHubDetailAcceptsSlugEnvelope", async () => {
  const client = fakeHttpClient(() =>
    jsonResponse(
      `{"skill":{"slug":"drivethru-operations","displayName":"Drivethru Operations","summary":"Operations","updatedAt":1784072685483},"latestVersion":{"version":"0.1.0"},"owner":{"displayName":"zmtucker"},"moderation":{"verdict":"clean"}}`,
    )
  );
  const detail = await createClawHubClient("https://api.test", client).detail(
    undefined,
    { market: "clawhub.ai", id: "drivethru-operations" },
  );
  assertEquals(detail.id, "drivethru-operations");
  assertEquals(detail.name, "Drivethru Operations");
  assertEquals(detail.version, "0.1.0");
  assertEquals(detail.author, "zmtucker");
});

test("ClawHubOwnerRefUsesOwnerQueryForDetail", async () => {
  const client = fakeHttpClient((url) => {
    const u = new URL(url);
    assertEquals(u.pathname, "/api/v1/skills/photo");
    assertEquals(u.searchParams.get("owner"), "agistack");
    return jsonResponse(
      `{"skill":{"slug":"photo","displayName":"Photo","summary":"Imaging"},"owner":{"displayName":"AGIstack"}}`,
    );
  });
  const detail = await createClawHubClient("https://api.test", client).detail(
    undefined,
    { market: "clawhub.ai", id: "@agistack/photo" },
  );
  assertEquals(detail.id, "@agistack/photo");
  assertEquals(detail.slug, "photo");
  assertEquals(detail.author, "AGIstack");
});

test("InstallValidatesArchiveAndWritesMetadata", async () => {
  const archive = await makeArchive({
    "wrapped/SKILL.md": "# Test\n",
    "wrapped/references/a.md": "reference",
  });
  const client = new FakeMarketClient();
  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "test-skill",
    slug: "test-skill",
    version: "1.0.0",
  });
  client.archive = archive;
  const target = path.join(await Deno.makeTempDir(), ".opensac", "skills");
  const result = await installSkill(undefined, client, {
    market: "skillhub.cn",
    id: "test-skill",
    scope: "project",
    targetDir: target,
  });
  assert(result.installed);
  assertEquals(result.dir, path.join(target, "test-skill"));
  const data = await Deno.readTextFile(path.join(result.dir, "SKILL.md"));
  assertEquals(data, "# Test\n");
  const metadata = readMetadata(result.dir);
  assertEquals(metadata.market, "skillhub.cn");
  assertEquals(metadata.id, "test-skill");
  assertEquals(metadata.version, "1.0.0");

  const second = await installSkill(undefined, client, {
    market: "skillhub.cn",
    id: "test-skill",
    scope: "project",
    targetDir: target,
  });
  assert(second.alreadyInstalled === true);

  const index = new LocalIndex("", [target]);
  const state = index.state("skillhub.cn", "test-skill");
  assertEquals(state?.scope, "project");
});

test("InstallRejectsTraversalAndLocalSkill", async () => {
  const target = await Deno.makeTempDir();
  const traversal = await makeArchive({ "../outside/SKILL.md": "# bad" });
  const client = new FakeMarketClient();
  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "bad",
    slug: "bad",
    version: "1",
  });
  client.archive = traversal;
  await assertRejects(
    () =>
      installSkill(undefined, client, {
        market: "skillhub.cn",
        id: "bad",
        targetDir: target,
      }),
    InvalidArchiveError,
  );
  await assertRejects(
    () => Deno.stat(path.join(path.dirname(target), "outside")),
    Deno.errors.NotFound,
  );

  await Deno.mkdir(path.join(target, "local"), { recursive: true });
  const local = new FakeMarketClient();
  local.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "local",
    slug: "local",
    version: "1",
  });
  local.archive = await makeArchive({ "SKILL.md": "# test" });
  await assertRejects(
    () =>
      installSkill(undefined, local, {
        market: "skillhub.cn",
        id: "local",
        targetDir: target,
      }),
    LocalSkillExistsError,
  );
  await assertRejects(
    () =>
      installSkill(undefined, local, {
        market: "skillhub.cn",
        id: "local",
        targetDir: target,
        overwrite: true,
      }),
    LocalSkillExistsError,
  );
});

test("InstallUpdatesManagedSkillAndRejectsDifferentOwner", async () => {
  const target = await Deno.makeTempDir();
  const client = new FakeMarketClient();
  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "managed",
    slug: "managed",
    version: "1.0.0",
  });
  client.archive = await makeArchive({ "SKILL.md": "version one" });
  const first = await installSkill(undefined, client, {
    market: "skillhub.cn",
    id: "managed",
    scope: "project",
    targetDir: target,
  });

  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "managed",
    slug: "managed",
    version: "2.0.0",
  });
  client.archive = await makeArchive({ "SKILL.md": "version two" });
  const updated = await installSkill(undefined, client, {
    market: "skillhub.cn",
    id: "managed",
    version: "2.0.0",
    scope: "project",
    targetDir: target,
    overwrite: true,
  });
  assertEquals(
    await Deno.readTextFile(path.join(updated.dir, "SKILL.md")),
    "version two",
  );
  assertEquals(readMetadata(updated.dir).version, "2.0.0");
  const backups = [...Deno.readDirSync(path.join(target, ".backup"))]
    .filter((e) => e.name.startsWith("managed-"));
  assertEquals(backups.length, 1);

  writeMetadata(first.dir, {
    market: "clawhub.ai",
    id: "another",
    version: "1",
  });
  const error = await assertRejects(
    () =>
      installSkill(undefined, client, {
        market: "skillhub.cn",
        id: "managed",
        version: "3.0.0",
        targetDir: target,
        overwrite: true,
      }),
  );
  assertStringIncludes((error as Error).message, "managed by");
});

test("LocalIndexMarksAvailableUpdate", async () => {
  const root = await Deno.makeTempDir();
  const dir = path.join(root, "go");
  await Deno.mkdir(dir, { recursive: true });
  writeMetadata(dir, { market: "skillhub.cn", id: "go", version: "1.0.0" });
  const index = new LocalIndex("", [root]);
  const items: SkillSummary[] = [{
    ...emptyDetail(),
    market: "skillhub.cn",
    id: "go",
    version: "2.0.0",
  }];
  index.apply(items);
  assertEquals(items[0].installed?.updateAvailable, true);
});

test("ServiceOfficialAggregatesAndAppliesInstalled", async () => {
  const global = await Deno.makeTempDir();
  const dir = path.join(global, "go-expert");
  await Deno.mkdir(dir, { recursive: true });
  writeMetadata(dir, { market: "skillhub.cn", id: "go-expert", version: "1" });
  const client = new FakeMarketClient();
  client.users = {
    one: [{
      ...emptyDetail(),
      market: "skillhub.cn",
      id: "go-expert",
      name: "Go",
      downloads: 10,
    }],
    two: [
      {
        ...emptyDetail(),
        market: "skillhub.cn",
        id: "go-expert",
        name: "Go",
        downloads: 10,
      },
      {
        ...emptyDetail(),
        market: "skillhub.cn",
        id: "other",
        name: "Other",
        downloads: 20,
      },
    ],
  };
  const service = new Service(global, [], ["one", "two"], client);
  const page = await service.official(undefined, {});
  assertEquals(page.items.length, 2);
  assertEquals(page.items[0].id, "other");
  assertEquals(page.items[1].installed?.installed, true);
  assertEquals(page.total, 2);
});

test("SkillHubBrowseSendsDownloadSortAndParsesCertification", async () => {
  const client = fakeHttpClient((url) => {
    const u = new URL(url);
    assertEquals(u.searchParams.get("sortBy"), "downloads");
    assertEquals(u.searchParams.get("order"), "desc");
    assertEquals(u.searchParams.get("category"), "dev-programming");
    return jsonResponse(
      `{"code":0,"data":{"total":1,"skills":[{"slug":"mail","name":"Mail","source":"enterprise","downloads":26129,"publisher":{"name":"QQ Mail","verified":true,"certifiedName":"Tencent"}}]}}`,
    );
  });
  const page = await createSkillHubClient("https://api.test", client).search(
    undefined,
    {
      limit: 10,
      sort: "downloads",
      order: "desc",
      category: "dev-programming",
    },
  );
  const item = page.items[0];
  assertEquals(item.downloads, 26129);
  assertEquals(item.source, "enterprise");
  assertEquals(item.publisherVerified, true);
  assertEquals(item.publisherName, "QQ Mail");
  assertEquals(item.certifiedName, "Tencent");
});

test("SkillHubCategories", async () => {
  const client = fakeHttpClient((url) => {
    assertEquals(new URL(url).pathname, "/api/v1/categories");
    return jsonResponse(
      `{"items":[{"key":"dev-programming","name":"开发编程","nameEn":"Development"}]}`,
    );
  });
  const categories = await createSkillHubClient("https://api.test", client)
    .categories(undefined);
  assertEquals(categories.length, 1);
  assertEquals(categories[0].key, "dev-programming");
});

test("ClawHubCurrentListShapeParsesDownloadsAndVersion", async () => {
  const client = fakeHttpClient(() =>
    jsonResponse(
      `{"items":[{"slug":"tool","displayName":"Tool","tags":{"latest":"1.2.0"},"stats":{"downloads":1562,"installs":6,"stars":3},"latestVersion":{"version":"1.2.0"},"updatedAt":1784072685483}]}`,
    )
  );
  const page = await createClawHubClient("https://api.test", client).search(
    undefined,
    { limit: 10 },
  );
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].downloads, 1562);
  assertEquals(page.items[0].version, "1.2.0");
  assert(page.items[0].updatedAt !== undefined);
});

test("ServiceDetailIncludesFiles", async () => {
  const client = new FakeMarketClient();
  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "go",
    version: "1",
  });
  client.fileList = true;
  client.fileEntries = [{ path: "SKILL.md" }, { path: "references/go.md" }];
  const detail = await new Service("", [], [], client as MarketClient).detail(
    undefined,
    "skillhub.cn",
    "go",
  );
  assertEquals(detail.files?.length, 2);
  assertEquals(detail.files?.[0].path, "SKILL.md");
  assertEquals(detail.downloadSources?.length, 1);
  assertEquals(detail.downloadSources?.[0].kind, "test");
});

test("ServiceDetailIncludesEvaluation", async () => {
  const client = new FakeMarketClient();
  client.detailValue = emptyDetail({
    market: "skillhub.cn",
    id: "go",
    version: "1",
  });
  client.evaluationCap = true;
  client.evaluationValue = {
    dimensions: { quality: {} },
  };
  const detail = await new Service("", [], [], client as MarketClient).detail(
    undefined,
    "skillhub.cn",
    "go",
  );
  assert(detail.evaluation !== null && detail.evaluation !== undefined);
});
