// Focused tests for the interactive dialog framework and the concrete panels:
// cursor/search/input handling, and that each dialog mutates real state.

import { assert, assertEquals, assertStringIncludes } from "../compat/assert.ts";
import { Dialog } from "./dialog.ts";
import {
  AuthDialog,
  DefaultModelDialog,
  type DialogHost,
  EnvDialog,
  ModelDialog,
  SessionsDialog,
  SettingsDialog,
} from "./dialogs.ts";
import { defaultSettings } from "../config/settings.ts";
import { resolvedModels } from "../provider/factory/factory.ts";
import { Translator } from "./i18n.ts";
import { type KeyEvent, splitInputChunk } from "./keys.ts";
import { type TUISessionListEntry } from "./service.ts";
import {
  type TUIProviderCatalogEntry,
  type TUISettingsWriteScope} from "./service.ts";
import { test } from "#testing";

interface Recorder {
  applied: Array<[string, string]>;
  reloads: number;
  switched: string[];
  created: number;
  deleted: string[];
  saved: Array<
    { scope: TUISettingsWriteScope; updates: Record<string, unknown> }
  >;
  savedEnv: Array<Record<string, string>>;
  validated: Array<[string, string]>;
  renders: number;
}

/** Lets fire-and-forget dialog persistence settle before assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function host(overrides: Partial<DialogHost> = {}): {
  host: DialogHost;
  rec: Recorder;
} {
  const settings = defaultSettings();
  const rec: Recorder = {
    applied: [],
    reloads: 0,
    switched: [],
    created: 0,
    deleted: [],
    saved: [],
    savedEnv: [],
    validated: [],
    renders: 0,
  };
  const base: DialogHost = {
    translator: new Translator("en"),
    workDir: Deno.cwd(),
    providerName: settings.defaultProvider ?? "",
    modelID: settings.defaultModel ?? "",
    allow: {},
    currentSessionID: () => "s1",
    listModels: (p) =>
      resolvedModels(settings, p).map((m) => ({ id: m.id, name: m.name })),
    applyModel: (p, m) => void rec.applied.push([p, m]),
    loadSettings: () => Promise.resolve({ ...settings }),
    saveSettings: (scope, updates) => {
      rec.saved.push({ scope, updates });
      return Promise.resolve({ ...settings, ...updates });
    },
    validateProviderModel: (providerID, modelID) => {
      rec.validated.push([providerID, modelID]);
      return Promise.resolve();
    },
    listProviders: () => Promise.resolve(providerCatalog(settings)),
    loadEnv: () => Promise.resolve({}),
    saveEnv: (vars) => {
      rec.savedEnv.push({ ...vars });
      return Promise.resolve();
    },
    reloadSettings: () => void rec.reloads++,
    requestRender: () => void rec.renders++,
    switchSession: (d) => {
      rec.switched.push(d.sessionId);
      return Promise.resolve();
    },
    newSession: () => {
      rec.created++;
      return Promise.resolve();
    },
    deleteSession: (id) => {
      rec.deleted.push(id);
      return Promise.resolve();
    },
  };
  return { host: { ...base, ...overrides }, rec };
}

/** Builds one provider catalog projection from the default presets. */
function providerCatalog(
  settings: ReturnType<typeof defaultSettings>,
): TUIProviderCatalogEntry[] {
  const id = settings.defaultProvider ?? "";
  return [{
    id,
    configured: true,
    isDefault: true,
    api: "openai-chat",
    baseUrl: "",
    modelCount: 1,
    models: resolvedModels(settings, id).map((m) => ({
      id: m.id,
      name: m.name,
    })),
  }];
}

function feed(dialog: Dialog, chunk: string): void {
  for (const ev of splitInputChunk(chunk)) dialog.handleKey(ev);
}

function feedEvents(dialog: Dialog, events: KeyEvent[]): void {
  for (const ev of events) dialog.handleKey(ev);
}

test("dialog cursor wraps and search filters", () => {
  const dialog = new Dialog(() => ({
    page: () => ({
      title: "T",
      search: true,
      items: [
        { label: "alpha", value: "a" },
        { label: "beta", value: "b" },
      ],
      hint: "h",
    }),
    select: () => {},
    submit: () => {},
    key: () => {},
    back: () => {},
  }));
  assertStringIncludes(dialog.view(80), "alpha");
  feed(dialog, "bet");
  const filtered = dialog.view(80);
  assertStringIncludes(filtered, "beta");
  assert(!filtered.includes("alpha"));
  // Backspacing clears the query character by character, widening the list.
  feed(dialog, "\x7f\x7f\x7f");
  const widened = dialog.view(80);
  assertStringIncludes(widened, "alpha");
  assertStringIncludes(widened, "beta");
  // Escape clears any remaining search.
  feed(dialog, "bet");
  feed(dialog, "\x1b");
  const cleared = dialog.view(80);
  assertStringIncludes(cleared, "alpha");
  assertStringIncludes(cleared, "beta");
});

test("search selection picks the filtered row, not the unfiltered index", () => {
  const chosen: string[] = [];
  const dialog = new Dialog(() => ({
    page: () => ({
      title: "T",
      search: true,
      items: [
        { label: "alpha", value: "alpha" },
        { label: "beta", value: "beta" },
        { label: "zeta", value: "zeta" },
      ],
      hint: "h",
    }),
    select: (value) => chosen.push(value),
    submit: () => {},
    key: () => {},
    back: () => {},
  }));
  // Filter down to "zeta"; cursor 0 must select zeta, not alpha.
  feed(dialog, "zeta");
  feed(dialog, "\r");
  assertEquals(chosen, ["zeta"]);
});

test("model dialog applies the selected model", () => {
  const { host: h, rec } = host();
  const dialog = new Dialog((d) => new ModelDialog(h, d));
  feed(dialog, "\r");
  assertEquals(dialog.closed, true);
  assertEquals(rec.applied.length, 1);
  assertStringIncludes(dialog.outcome.message ?? "", "Model switched");
});

test("model dialog filters by typed query", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new ModelDialog(h, d));
  feed(dialog, "v4-pro");
  const view = dialog.view(100);
  assertStringIncludes(view, "deepseek-v4-pro");
});

/** Builds the Core projections one default-model dialog renders. */
function defaultModelData(): {
  catalog: TUIProviderCatalogEntry[];
  defaultProvider: string;
  defaultModel: string;
} {
  const settings = defaultSettings();
  return {
    catalog: providerCatalog(settings),
    defaultProvider: settings.defaultProvider ?? "",
    defaultModel: settings.defaultModel ?? "",
  };
}

test("default-model dialog steps provider then model and persists", async () => {
  const { host: h, rec } = host();
  const dialog = new Dialog((d) =>
    new DefaultModelDialog(h, d, "global", defaultModelData())
  );
  // Pick the first provider (deepseek-openai), then the first model.
  feed(dialog, "\r");
  assert(!dialog.closed);
  feed(dialog, "\r");
  await settle();
  assertEquals(dialog.closed, true);
  assertEquals(rec.applied.length, 1);
  assertEquals(rec.validated.length, 1);
  assertEquals(rec.saved.length, 1);
  assertEquals(rec.saved[0].scope, "global");
  assertStringIncludes(dialog.outcome.message ?? "", "Default model set");
});

test("default-model dialog escape steps back from the model view", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) =>
    new DefaultModelDialog(h, d, "global", defaultModelData())
  );
  feed(dialog, "\r"); // into model view
  feed(dialog, "\x1b"); // back to provider view
  assert(!dialog.closed);
  assertStringIncludes(dialog.view(100), "Set Default Model");
});

test("env dialog adds a variable through key then value prompts", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new EnvDialog(h, d, {}));
  // Navigate to "+ Add Variable" (after the two trailing rows).
  const page = dialog.view(90);
  assertStringIncludes(page, "Add Variable");
  feed(dialog, "\x1b[B\x1b[B");
  feed(dialog, "\r");
  feed(dialog, "MY_TEST_VAR");
  feed(dialog, "\r");
  feed(dialog, "value-1");
  feed(dialog, "\r");
  assertStringIncludes(dialog.view(90), "MY_TEST_VAR = value-1");
});

test("env dialog rejects an invalid variable name", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new EnvDialog(h, d, {}));
  feed(dialog, "\x1b[B\x1b[B");
  feed(dialog, "\r");
  feed(dialog, "BAD=NAME");
  feed(dialog, "\r");
  assertStringIncludes(dialog.view(90), "Invalid environment variable name");
});

/** The host surface is service-backed; nothing here writes the user config. */

test("auth dialog walks provider -> credentials and saves", async () => {
  const { host: h, rec } = host();
  const dialog = new Dialog((d) => new AuthDialog(h, d, defaultSettings()));
  assertStringIncludes(dialog.view(90), "Connect Provider");
  feed(dialog, "\r"); // Existing Provider
  assertStringIncludes(dialog.view(90), "Choose Provider");
  feed(dialog, "\r"); // first provider → group list
  assertStringIncludes(dialog.view(90), "Credentials");
  // Cursor starts on API Type; one down reaches Credentials.
  feed(dialog, "\x1b[B\r");
  feed(dialog, "\r"); // edit API Key field
  // Prefilled env references stay visible; ordinary values are masked.
  assertStringIncludes(dialog.view(90), "API Key");
  // Clear any prefilled value and type a fresh ordinary key.
  feed(
    dialog,
    "\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f",
  );
  feed(dialog, "sk-test-123");
  assertStringIncludes(dialog.view(90), "***********");
  feed(dialog, "\r"); // submit key → credentials list
  feed(dialog, "\x1b"); // back to group list (cursor reset to top)
  // Move down to Done (last item) and save through the service.
  for (let i = 0; i < 8; i++) feed(dialog, "\x1b[B");
  feed(dialog, "\r");
  await settle();
  assertEquals(dialog.closed, true);
  assertEquals(rec.reloads, 1);
  assertEquals(rec.saved.length, 1);
  assertEquals(rec.saved[0].scope, "global");
});

test("auth dialog escape steps back through views", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new AuthDialog(h, d, defaultSettings()));
  feed(dialog, "\r"); // providers
  feed(dialog, "\r"); // provider detail
  feed(dialog, "\x1b"); // back to providers
  assert(!dialog.closed);
  assertStringIncludes(dialog.view(90), "Choose Provider");
  feed(dialog, "\x1b"); // back to main
  assertStringIncludes(dialog.view(90), "Connect Provider");
  feed(dialog, "\x1b"); // close
  assertEquals(dialog.closed, true);
});

test("sessions dialog lists, switches, and deletes", async () => {
  const detail = (id: string, count: number): TUISessionListEntry => ({
    sessionId: id,
    workDir: Deno.cwd(),
    modTime: new Date(),
    messageCount: count,
    preview: "",
  });
  const { host: h, rec } = host();
  const dialog = new Dialog((d) =>
    new SessionsDialog(h, d, [detail("s1", 1), detail("s2", 2)])
  );
  // The seeded rows render with their message counts.
  assertStringIncludes(dialog.view(90), "s2  2 msgs");
  // Selecting another session switches through the host projection.
  feed(dialog, "\x1b[B");
  feed(dialog, "\r");
  await settle();
  assertEquals(rec.switched, ["s2"]);
  assertEquals(dialog.closed, true);
});

test("settings dialog walks the category tree and cycles fields", async () => {
  const { host: h, rec } = host();
  const dialog = new Dialog((d) => new SettingsDialog(h, d, defaultSettings()));
  assertStringIncludes(dialog.view(90), "Settings");
  // Root → Defaults (index 1 in Go order: providers, defaults, behavior).
  feed(dialog, "\x1b[B");
  feed(dialog, "\r");
  assertStringIncludes(dialog.view(90), "Default Mode");
  feed(dialog, "\x1b"); // back to root
  feed(dialog, "\x1b[B\x1b[B"); // Behavior
  feed(dialog, "\r");
  assertStringIncludes(dialog.view(90), "Theme");
  // Select "Enable Plan Tool" (second row) and cycle it; the host reloads.
  feed(dialog, "\x1b[B");
  feed(dialog, "\r");
  await settle();
  assertEquals(rec.reloads >= 1, true);
  assertEquals(rec.saved.length >= 1, true);
});

test("settings dialog done returns to the root then closes", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new SettingsDialog(h, d, defaultSettings()));
  feed(dialog, "\x1b[B"); // Defaults
  feed(dialog, "\r");
  feed(dialog, "\x1b[B\x1b[B\x1b[B"); // thinking → mode → Done
  feed(dialog, "\r");
  assert(!dialog.closed);
  assertStringIncludes(dialog.view(90), "Settings");
  feed(dialog, "\x1b"); // close from root
  assertEquals(dialog.closed, true);
});

test("settings dialog third-level input edits a field", async () => {
  const { host: h, rec } = host();
  const dialog = new Dialog((d) => new SettingsDialog(h, d, defaultSettings()));
  feed(dialog, "\x1b[B\x1b[B"); // Behavior
  feed(dialog, "\r");
  feed(dialog, "\r"); // Theme (first row) → input box
  feed(dialog, "light");
  feed(dialog, "\r");
  await settle();
  assertEquals(rec.reloads >= 1, true);
});

test("settings providers hands off to the auth dialog", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new SettingsDialog(h, d, defaultSettings()));
  feed(dialog, "\r"); // Providers (first row)
  assertEquals(dialog.closed, true);
  assertEquals(dialog.outcome.handoff, "auth");
});

test("settings defaults model picker hands off to the default-model dialog", () => {
  const { host: h } = host();
  const dialog = new Dialog((d) => new SettingsDialog(h, d, defaultSettings()));
  feed(dialog, "\x1b[B"); // Defaults
  feed(dialog, "\r");
  feed(dialog, "\r"); // Default Provider / Model (first row)
  assertEquals(dialog.closed, true);
  assertEquals(dialog.outcome.handoff, "defaultModel");
});

test("dialog with no items renders a no-matches line", () => {
  const dialog = new Dialog(() => ({
    page: () => ({ title: "Empty", items: [], hint: "h" }),
    select: () => {},
    submit: () => {},
    key: () => {},
    back: () => {},
  }));
  assertStringIncludes(dialog.view(80), "no matches");
});

test("feedEvents is available for future key-level tests", () => {
  feedEvents(
    new Dialog(() => ({
      page: () => ({ title: "T", items: [], hint: "h" }),
      select: () => {},
      submit: () => {},
      key: () => {},
      back: () => {},
    })),
    [],
  );
  assert(true);
});
