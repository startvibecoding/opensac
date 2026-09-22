// Focused tests for TUI slice-2 components: the bilingual i18n translator
// (fallback chain, auto resolution, sprintf subset), the header layout
// (logo + rounded info panel, responsive collapse), and the agent tab bar
// (state icons, active highlighting, truncation, hidden when ≤1 agent).

import { assertEquals } from "@std/assert";
import {
  catalogs,
  parseConfigured,
  resolveLanguage,
  sprintf,
  Translator,
  utcOffset,
} from "./i18n.ts";
import { displayWidth, truncateDisplay } from "./formatters.ts";
import { logoWidth, opensacLogo, renderHeader } from "./header.ts";
import { type AgentTab, renderAgentTabBar } from "./agent_tabbar.ts";

// ─── i18n ───────────────────────────────────────────────────────────────────

Deno.test("parseConfigured normalizes and rejects unknown values", () => {
  assertEquals(parseConfigured(""), { configured: "auto", valid: true });
  assertEquals(parseConfigured(" AUTO "), { configured: "auto", valid: true });
  assertEquals(parseConfigured("zh"), { configured: "zh", valid: true });
  assertEquals(parseConfigured("EN"), { configured: "en", valid: true });
  assertEquals(parseConfigured("fr"), { configured: "auto", valid: false });
});

Deno.test("resolveLanguage uses UTC+8 for auto and null zone falls to en", () => {
  const now = new Date("2026-09-20T04:00:00Z"); // 12:00 in +08:00
  assertEquals(resolveLanguage("auto", now, "Asia/Shanghai"), "zh");
  assertEquals(resolveLanguage("auto", now, "America/New_York"), "en");
  assertEquals(resolveLanguage("auto", now, null), "en");
  assertEquals(resolveLanguage("zh", now, null), "zh");
  assertEquals(resolveLanguage("en", now, "Asia/Shanghai"), "en");
});

Deno.test("utcOffset renders the Go format", () => {
  const now = new Date("2026-09-20T04:00:00Z");
  assertEquals(utcOffset(now, "Asia/Shanghai"), "UTC+08:00");
  assertEquals(utcOffset(now, "America/New_York"), "UTC-04:00");
  assertEquals(utcOffset(now, null), "unknown");
});

Deno.test("sprintf supports %s %d %v %% and %02d", () => {
  assertEquals(sprintf("[ %s %s ]", ["●", "a1"]), "[ ● a1 ]");
  assertEquals(sprintf("%d rows", [5]), "5 rows");
  assertEquals(sprintf("%v", [{ id: 1 }]), "[object Object]");
  assertEquals(sprintf("100%%"), "100%");
  assertEquals(sprintf("%02d:%02d", [1, 2]), "01:02");
  assertEquals(sprintf("%02d:%02d", [-1, 59]), "-01:59"); // Go pads abs value with sign
});

Deno.test("Translator falls back zh → en → id and formats args", () => {
  const zh = new Translator("zh");
  const en = new Translator("en");
  assertEquals(zh.language, "zh");
  assertEquals(zh.text("tool.modal.state.running"), "运行中");
  assertEquals(en.text("tool.modal.state.running"), "running");
  assertEquals(
    zh.text("tool.modal.agent_tab", "●", "agent-1"),
    "[ ● agent-1 ]",
  );
  // Missing in zh but present in en
  catalogs.en["test.only.en"] = "english only";
  assertEquals(zh.text("test.only.en"), "english only");
  // Missing everywhere falls back to the raw id
  assertEquals(zh.text("test.missing.everywhere"), "test.missing.everywhere");
  delete catalogs.en["test.only.en"];
  // Unknown language coerces to en
  assertEquals(new Translator("fr" as never).language, "en");
  // fromConfig resolves once
  const { translator } = Translator.fromConfig(
    "auto",
    () => new Date("2026-09-20T04:00:00Z"),
    "Asia/Shanghai",
  );
  assertEquals(translator.language, "zh");
});

// ─── header ─────────────────────────────────────────────────────────────────

Deno.test("logoWidth measures the widest logo line in cells", () => {
  const lines = opensacLogo.split("\n");
  assertEquals(lines.length, 5);
  assertEquals(logoWidth(), Math.max(...lines.map(displayWidth)));
  assertEquals(logoWidth(), 28); // block runes are 1 cell each
});

Deno.test("renderHeader shows logo and info panel at full width", () => {
  const header = renderHeader(120, "1.2.3", "deepseek", "v4", "/home/u/proj");
  const lines = header.split("\n");
  // One panel plus logo lines: header height == info panel height (6 =
  // 4 content rows + top/bottom border)
  assertEquals(lines.length, 6);
  // deno-lint-ignore no-control-regex
  const text = header.replace(/\u001B\[[0-9;]*m/g, "");
  assert(text.includes("OpenSAC (1.2.3)"), text);
  assert(text.includes("deepseek | v4"), text);
  assert(text.includes("/home/u/proj"), text);
  assert(text.includes("Make OSCHINA Tokens Harness eXecution"));
  // Rounded border corners present
  assert(text.includes("╭"));
  assert(text.includes("╰"));
  // All rows share the same total width (grid alignment)
  const widths = new Set(lines.map(displayWidth));
  assertEquals(widths.size, 1);
});

Deno.test("renderHeader collapses to the info panel when narrow", () => {
  const header = renderHeader(40, "1.2.3", "deepseek", "v4", "/very/long/path");
  // deno-lint-ignore no-control-regex
  const text = header.replace(/\u001B\[[0-9;]*m/g, "");
  // Logo's widest line is 29 cells; 40 < 29 + panel + 2 → logo omitted
  assert(!text.includes("██"), text);
  // cwd truncated to fit
  assert(text.split("\n").every((l) => displayWidth(l) <= 42));
});

// ─── agent tab bar ──────────────────────────────────────────────────────────

Deno.test("renderAgentTabBar hides with 0 or 1 agents", () => {
  const tr = new Translator("en");
  assertEquals(renderAgentTabBar(tr, [], "a", 80), "");
  assertEquals(
    renderAgentTabBar(tr, [{ id: "a", state: "ready" }], "a", 80),
    "",
  );
});

Deno.test("renderAgentTabBar renders tabs with state and active highlight", () => {
  const tr = new Translator("en");
  const tabs: AgentTab[] = [
    { id: "lead", state: "running" },
    { id: "worker", state: "done" },
  ];
  const bar = renderAgentTabBar(tr, tabs, "lead", 120);
  // deno-lint-ignore no-control-regex
  const text = bar.replace(/\u001B\[[0-9;]*m/g, "");
  assert(text.includes("[ o lead ] (running)"), text);
  assert(text.includes("[ + worker ] (done)"), text);
  // Bottom border row
  const [row, border] = bar.split("\n");
  assertEquals(
    displayWidth(border.replace(
      // deno-lint-ignore no-control-regex
      /\u001B\[[0-9;]*m/g,
      "",
    )),
    120,
  );
  assert(row.includes("lead"));
  // Active tab carries the accent color code
  assert(row.includes("\u001B[38;5;86m"));
});

Deno.test("renderAgentTabBar truncates overlong rows", () => {
  const tr = new Translator("en");
  const tabs: AgentTab[] = Array.from({ length: 8 }, (_, i) => ({
    id: `agent-${i}-with-a-really-long-name`,
    state: "running" as const,
  }));
  const bar = renderAgentTabBar(
    tr,
    tabs,
    "agent-0-with-a-really-long-name",
    40,
  );
  const [row] = bar.split("\n");
  assertEquals(displayWidth(row), 40);
});

// ─── shared helpers used above ──────────────────────────────────────────────

function assert(condition: unknown, message?: string): void {
  if (!condition) throw new Error(message ?? "assertion failed");
}

// Re-assert truncateDisplay/grid behavior the components rely on.
Deno.test("truncateDisplay keeps grid alignment for tab bar rows", () => {
  assertEquals(truncateDisplay("abcdef", 4), "a...");
  assertEquals(displayWidth(truncateDisplay("中文中文中文", 7)), 7);
});
