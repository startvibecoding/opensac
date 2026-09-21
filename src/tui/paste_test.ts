// Focused tests for paste folding/expansion (Go handlePaste / expandPasteMarkers).

import { assertEquals } from "@std/assert";
import { PasteStore } from "./paste.ts";

Deno.test("small pastes insert directly without a marker", () => {
  const store = new PasteStore();
  assertEquals(store.fold("hello world"), "hello world");
  assertEquals(store.size, 0);
});

Deno.test("multi-line pastes fold to a line marker", () => {
  const store = new PasteStore();
  const payload = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
  const marker = store.fold(payload);
  assertEquals(marker, "[paste #1 +8 lines]");
  assertEquals(store.size, 1);
});

Deno.test("single-line long pastes fold to a char marker", () => {
  const store = new PasteStore();
  const payload = "x".repeat(600);
  const marker = store.fold(payload);
  assertEquals(marker, "[paste #1 600 chars]");
});

Deno.test("expand restores folded content and drops the used entry", () => {
  const store = new PasteStore();
  const payload = Array.from({ length: 8 }, (_, i) => `l${i}`).join("\n");
  const marker = store.fold(payload);
  assertEquals(
    store.expand(`before ${marker} after`),
    `before ${payload} after`,
  );
  assertEquals(store.size, 0);
});

Deno.test("expand leaves unreferenced pastes intact", () => {
  const store = new PasteStore();
  store.fold("x".repeat(600));
  assertEquals(store.expand("no marker here"), "no marker here");
  assertEquals(store.size, 1);
  store.reset();
  assertEquals(store.size, 0);
});
