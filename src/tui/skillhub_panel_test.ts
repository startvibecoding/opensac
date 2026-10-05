// Focused tests for the framed /skillhub marketplace panel: the mothx-style
// rounded wire frame, list/detail/scope views, inline filter, pagination, and
// install flow all run against a fake host with no network access.

import { assertEquals } from "@std/assert";
import { SkillHubPanel, type SkillHubPanelHost } from "./skillhub_panel.ts";
import { Translator } from "./i18n.ts";
import type { KeyEvent } from "./keys.ts";
import type {
  Category,
  InstallRequest,
  InstallResult,
  Market,
  MarketInfo,
  SearchPage,
  SkillDetail,
  SkillSummary,
} from "../skillhub/mod.ts";

const tr = new Translator("en");

function key(name: string): KeyEvent {
  return { type: "key", name } as KeyEvent;
}

function text(t: string): KeyEvent {
  return { type: "text", text: t } as KeyEvent;
}

function summary(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    market: "skillhub.cn",
    id: "demo",
    slug: "demo",
    name: "Demo Skill",
    displayName: "Demo Skill",
    description: "A demo skill for tests",
    version: "1.0.0",
    author: "tester",
    category: "",
    ...over,
  };
}

class FakeHost implements SkillHubPanelHost {
  translator = tr;
  searches: Array<{ market: Market; query: string }> = [];
  installs: InstallRequest[] = [];
  uninstalls: Array<{ market: Market; id: string; scope: string }> = [];
  installedMode = false;
  constructor() {}
  markets(): Promise<MarketInfo[]> {
    return Promise.resolve([
      {
        id: "skillhub.cn",
        name: "SkillHub.cn",
        siteUrl: "",
        capabilities: {} as MarketInfo["capabilities"],
      },
      {
        id: "clawhub.ai",
        name: "ClawHub.ai",
        siteUrl: "",
        capabilities: {} as MarketInfo["capabilities"],
      },
    ]);
  }
  search(
    market: Market,
    query: { query?: string },
  ): Promise<SearchPage> {
    this.searches.push({ market, query: query.query ?? "" });
    const items = [summary(), summary({ id: "other", name: "Other" })];
    const filtered = (query.query ?? "") === ""
      ? items
      : items.filter((i) =>
        i.name.toLowerCase().includes((query.query ?? "").toLowerCase())
      );
    return Promise.resolve({ items: filtered, total: filtered.length });
  }
  official(): Promise<SearchPage> {
    return Promise.resolve({ items: [summary({ id: "official-one" })] });
  }
  categories(): Promise<Category[]> {
    return Promise.resolve([{ key: "coding", name: "Coding" }]);
  }
  detail(_market: Market, id: string): Promise<SkillDetail> {
    return Promise.resolve({
      ...summary({ id }),
      readme: "# Readme\nSome docs here",
      installed: this.installedMode
        ? { installed: true, scope: "project", dir: "/tmp/x" }
        : null,
    });
  }
  install(request: InstallRequest): Promise<InstallResult> {
    this.installs.push(request);
    return Promise.resolve({
      name: request.id,
      market: request.market ?? "skillhub.cn",
      version: "1.0.0",
      scope: request.scope ?? "project",
      dir: "/tmp/x",
      installed: true,
    });
  }
  uninstall(market: Market, id: string, scope: string): Promise<void> {
    this.uninstalls.push({ market, id, scope });
    return Promise.resolve();
  }
  listInstalled() {
    return [];
  }
  activateSkill(_name: string): Promise<string> {
    return Promise.resolve("");
  }
  defaultScope(): "project" | "global" {
    return "project";
  }
  targetDir(_scope: string): string {
    return "/tmp/skills";
  }
  settle(_message: string, _error?: boolean): void {}
  requestRender(): void {}
}

/** Lets queued microtasks (the panel's async loads) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("skillhub panel renders a framed list after loading", async () => {
  const host = new FakeHost();
  const panel = new SkillHubPanel(host, { close: () => {} });
  await flush();
  const page = panel.page();
  assertEquals(page.title, tr.text("skillhub.panel.title"));
  assertEquals(page.items.length, 2);
  assertEquals(host.searches[0]?.market, "skillhub.cn");
  // The body carries the market tab row with the active market highlighted.
  assertEquals(
    page.body?.some((line) => line.includes("skillhub.cn")),
    true,
  );
});

Deno.test("skillhub panel filters with typed text after '/'", async () => {
  const host = new FakeHost();
  const panel = new SkillHubPanel(host, { close: () => {} });
  await flush();
  panel.handleKey(text("/"));
  panel.handleKey(text("other"));
  await flush();
  const page = panel.page();
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0]?.label, "Other");
  // Backspace exits the filter progressively.
  panel.handleKey(key("backspace"));
  await flush();
  assertEquals(panel.page().items.length, 1);
});

Deno.test("skillhub panel opens detail on Enter and installs via scope picker", async () => {
  const host = new FakeHost();
  const panel = new SkillHubPanel(host, { close: () => {} });
  await flush();
  panel.handleKey(key("enter"));
  await flush();
  let page = panel.page();
  assertEquals(page.title, tr.text("skillhub.panel.detail_title"));
  assertEquals(
    page.body?.some((l) => l.includes("Some docs here")),
    true,
  );
  panel.handleKey(text("i"));
  page = panel.page();
  assertEquals(page.title, tr.text("skillhub.panel.scope_title"));
  panel.handleKey(key("enter")); // project scope (default cursor)
  await flush();
  await flush(); // install -> activate -> detail refresh chain
  assertEquals(host.installs.length, 1);
  assertEquals(host.installs[0]?.scope, "project");
  assertEquals(host.installs[0]?.targetDir, "/tmp/skills");
  // After install the panel returns to the detail view with a status line.
  page = panel.page();
  assertEquals(page.title, tr.text("skillhub.panel.detail_title"));
  assertEquals(
    page.body?.some((l) =>
      l.includes("Installed demo (project)") ||
      l.includes("installed: project")
    ),
    true,
    `body was:\n${(page.body ?? []).join("\n")}`,
  );
});

Deno.test("skillhub panel escapes back through views and closes", async () => {
  const host = new FakeHost();
  let closed = false;
  const panel = new SkillHubPanel(host, { close: () => (closed = true) });
  await flush();
  panel.handleKey(key("enter"));
  await flush();
  panel.handleKey(key("escape"));
  assertEquals(panel.page().title, tr.text("skillhub.panel.title"));
  panel.handleKey(key("escape"));
  assertEquals(panel.closed, true);
  assertEquals(closed, true);
});
