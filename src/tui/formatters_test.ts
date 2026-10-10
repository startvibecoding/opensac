// Focused tests for the ported TUI formatting helpers: display-width
// truncation (CJK=2 cells, ANSI=0), bash output compaction, and duration
// formatting, all mirroring internal/tui/formatters.go semantics.

import { assertEquals } from "../compat/assert.ts";
import {
  cacheHitPercent,
  compactBashOutput,
  displayWidth,
  formatCachePercent,
  formatDuration,
  formatTokens,
  truncateDisplay,
} from "./formatters.ts";
import { test } from "#testing";

test("displayWidth counts CJK as 2 and strips ANSI", () => {
  assertEquals(displayWidth("abc"), 3);
  assertEquals(displayWidth("中文"), 4);
  assertEquals(displayWidth("a中b"), 4);
  assertEquals(displayWidth("\u001B[31mred\u001B[0m"), 3);
  assertEquals(displayWidth(""), 0);
});

test("truncateDisplay respects display width and adds ellipsis", () => {
  assertEquals(truncateDisplay("short", 10), "short");
  assertEquals(truncateDisplay("a-very-long-line", 8), "a-ver...");
  assertEquals(truncateDisplay("", 5), "");
  assertEquals(truncateDisplay("anything", 0), "");
  assertEquals(truncateDisplay("anything", -1), "");
  // maxWidth smaller than the suffix: return the suffix itself
  assertEquals(truncateDisplay("anything", 2), "...");
  // CJK: "中文中文" is 8 cells; maxWidth 5 → target 2 → 1 char + "..."
  assertEquals(truncateDisplay("中文中文", 5), "中...");
  // ANSI escapes consume no width
  assertEquals(
    truncateDisplay("\u001B[1mbold\u001B[0m", 4),
    "\u001B[1mbold\u001B[0m",
  );
});

test("compactBashOutput trims lines and collapses blank runs", () => {
  assertEquals(compactBashOutput("  a  \n\n\n b \n"), "a\n\nb");
  assertEquals(compactBashOutput("\n\n"), "");
  assertEquals(compactBashOutput(""), "");
  assertEquals(compactBashOutput("single"), "single");
});

test("formatDuration matches the Go status line", () => {
  assertEquals(formatDuration(0), "<1s");
  assertEquals(formatDuration(999), "<1s");
  assertEquals(formatDuration(1000), "1s");
  assertEquals(formatDuration(59_000), "59s");
  assertEquals(formatDuration(61_000), "1m01s");
  assertEquals(formatDuration(3_600_000), "1h00m");
  assertEquals(formatDuration(3_660_000), "1h01m");
});

test("formatTokens matches the Go compact format", () => {
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(1200), "1.2k");
  assertEquals(formatTokens(12_000), "12k");
  assertEquals(formatTokens(1_200_000), "1.2M");
});

test("formatCachePercent mirrors the Go footer logic", () => {
  const noUsage = {
    totalInputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
  };
  assertEquals(formatCachePercent(noUsage), "");
  assertEquals(cacheHitPercent(noUsage), -1);
  const full = {
    totalInputTokens: 1000,
    totalCacheRead: 800,
    totalCacheWrite: 0,
  };
  assertEquals(formatCachePercent(full), "Cache: 80%");
  assertEquals(cacheHitPercent(full), 80);
  const writeOnly = {
    totalInputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 42,
  };
  assertEquals(formatCachePercent(writeOnly), "CacheWrite: 42");
});
