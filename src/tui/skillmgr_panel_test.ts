// Focused tests for the framed /skillmgr panel: the mothx-style merged skill
// manager (checkbox list over the former /skills listing + /skill activation)
// runs against a fake host with no session or Core access.

import { assertEquals, assertStringIncludes } from "../compat/assert.ts";
import { SkillMgrPanel, type SkillMgrPanelHost } from "./skillmgr_panel.ts";
import { Translator } from "./i18n.ts";
import { type KeyEvent } from "./keys.ts";
import { type TUISkillView } from "./service.ts";
import { test } from "#testing";

const tr = new Translator("en");

function key(name: string): KeyEvent {
  return { type: "key", name } as KeyEvent;
}

function text(t: string): KeyEvent {
  return { type: "text", text: t } as KeyEvent;
}

function skill(over: Partial<TUISkillView> = {}): TUISkillView {
  return {
    name: "demo",
    source: "project",
    description: "Demo skill",
    active: false,
    ...over,
  };
}

class FakeHost implements SkillMgrPanelHost {
  translator = tr;
  skills: TUISkillView[] = [skill()];
  locked: string[] = [];
  toggles: Array<{ name: string; active: boolean }> = [];
  settled: Array<{ message: string; error?: boolean }> = [];
  closed = false;
  renders = 0;
  listError: Error | undefined;
  listSkills(): Promise<TUISkillView[]> {
    if (this.listError !== undefined) return Promise.reject(this.listError);
    return Promise.resolve(this.skills);
  }
  setSkillActive(name: string, active: boolean): Promise<void> {
    this.toggles.push({ name, active });
    return Promise.resolve();
  }
  lockedNames(): string[] {
    return this.locked;
  }
  settle(message: string, error?: boolean): void {
    this.settled.push({ message, error });
  }
  requestRender(): void {
    this.renders += 1;
  }
}

async function open(host: FakeHost): Promise<SkillMgrPanel> {
  const panel = new SkillMgrPanel(host, {
    close: () => {
      host.closed = true;
    },
  });
  // Let the async list load settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return panel;
}

async function press(panel: SkillMgrPanel, ev: KeyEvent): Promise<void> {
  panel.handleKey(ev);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("skillmgr seeds the pending selection from the active skills", async () => {
  const host = new FakeHost();
  host.skills = [
    skill({ name: "a", active: true }),
    skill({ name: "b", source: "global" }),
  ];
  const panel = await open(host);
  assertEquals(panel.closed, false);
  const view = panel.view(100);
  assertStringIncludes(view, "Skill Manager");
  // Rows carry cursor/name ANSI colors; match around them.
  assertEquals(/\[x\][^\n]*a[^\n]*\(project\)/.test(view), true);
  assertEquals(/\[ \][^\n]*b[^\n]*\(global\)/.test(view), true);
  assertStringIncludes(view, "1/2 active");
});

test("skillmgr moves the cursor with arrows and j/k without wrapping", async () => {
  const host = new FakeHost();
  host.skills = [skill({ name: "a" }), skill({ name: "b" })];
  const panel = await open(host);
  await press(panel, key("down"));
  assertEquals(panel.cursor, 1);
  await press(panel, key("down"));
  assertEquals(panel.cursor, 1, "cursor clamps at the end (mothx)");
  await press(panel, text("k"));
  assertEquals(panel.cursor, 0);
  await press(panel, text("k"));
  assertEquals(panel.cursor, 0, "cursor clamps at the top (mothx)");
  await press(panel, text("j"));
  assertEquals(panel.cursor, 1);
});

test("skillmgr space toggles and enter applies the diff once", async () => {
  const host = new FakeHost();
  host.skills = [
    skill({ name: "a", active: true }),
    skill({ name: "b" }),
    skill({ name: "c" }),
  ];
  const panel = await open(host);
  // Deactivate "a", activate "b"; leave "c" alone.
  await press(panel, text(" ")); // toggle a off
  await press(panel, key("down"));
  await press(panel, text(" ")); // toggle b on
  await press(panel, key("enter"));
  assertEquals(host.toggles, [
    { name: "b", active: true },
    { name: "a", active: false },
  ]);
  assertEquals(panel.closed, true);
  assertEquals(host.closed, true);
  assertEquals(host.settled.length, 1);
  assertStringIncludes(host.settled[0].message, "b");
  assertStringIncludes(host.settled[0].message, "a");
});

test("skillmgr enter without changes settles no_change", async () => {
  const host = new FakeHost();
  host.skills = [skill({ name: "a", active: true })];
  const panel = await open(host);
  await press(panel, key("enter"));
  assertEquals(host.toggles, []);
  assertEquals(panel.closed, true);
  assertEquals(host.settled[0].message, tr.text("skillmgr.no_change"));
});

test("skillmgr locked skills render builtin and refuse toggles", async () => {
  const host = new FakeHost();
  host.skills = [skill({ name: "vibe-browser", source: "builtin" })];
  host.locked = ["vibe-browser"];
  const panel = await open(host);
  assertStringIncludes(panel.view(100), "(builtin)");
  await press(panel, text(" "));
  assertStringIncludes(
    panel.view(100),
    tr.text("skillmgr.locked", "vibe-browser"),
  );
  await press(panel, key("enter"));
  assertEquals(host.toggles, []);
  assertEquals(host.settled[0].message, tr.text("skillmgr.no_change"));
});

test("skillmgr esc/q close without applying pending toggles", async () => {
  const host = new FakeHost();
  host.skills = [skill({ name: "a" })];
  const panel = await open(host);
  await press(panel, text(" "));
  await press(panel, key("escape"));
  assertEquals(panel.closed, true);
  assertEquals(host.toggles, []);
  assertEquals(host.settled, []);

  const host2 = new FakeHost();
  host2.skills = [skill({ name: "a" })];
  const panel2 = await open(host2);
  await press(panel2, text(" "));
  await press(panel2, text("q"));
  assertEquals(panel2.closed, true);
  assertEquals(host2.toggles, []);
});

test("skillmgr closes with skills.empty when nothing is found", async () => {
  const host = new FakeHost();
  host.skills = [];
  const panel = await open(host);
  assertEquals(panel.closed, true);
  assertEquals(host.settled[0].message, tr.text("skills.empty"));
});

test("skillmgr reports a list failure as an error settle", async () => {
  const host = new FakeHost();
  host.listError = new Error("core down");
  const panel = await open(host);
  assertEquals(panel.closed, true);
  assertEquals(host.settled[0], { message: "core down", error: true });
});

test("skillmgr windows long lists around the cursor", async () => {
  const host = new FakeHost();
  host.skills = Array.from({ length: 30 }, (_, i) => skill({ name: `s${i}` }));
  const panel = await open(host);
  let view = panel.view(100);
  assertStringIncludes(view, "s0");
  assertEquals(view.includes("s20"), false);
  assertStringIncludes(view, "showing 1-12 of 30");
  for (let i = 0; i < 25; i++) await press(panel, key("down"));
  view = panel.view(100);
  assertStringIncludes(view, "s25");
  assertEquals(panel.cursor, 25);
});
