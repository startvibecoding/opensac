// Tests for the structured /auth dialog (auth_dialog.ts), covering the
// navigation tree ported from the Go TUI: provider groups, field toggles,
// headers, model add, and draft → config persistence.

import { assert, assertEquals } from "../compat/assert.ts";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import { AuthDialog } from "./auth_dialog.ts";
import { type AuthHost, type AuthPanel } from "./auth_dialog.ts";
import {
  configDir,
  loadGlobalSettingsSparse,
  loadSettingsFor,
  type ProviderConfig,
  saveGlobalSettingsPatch,
  saveProjectSettingsPatchFor,
  type Settings,
} from "../config/settings.ts";

/** Lets the fire-and-forget confirm persistence settle before assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHost(): AuthHost {
  return {
    translator: {
      text: (id: string, ...args: unknown[]) =>
        args.length ? `${id}(${args.join(",")})` : id,
    },
    applyModel: () => {},
    reloadSettings: () => {},
    // The dialog persists through the service; the tests back it with the real
    // config APIs inside an isolated OPENSAC_DIR to keep the round-trip honest.
    loadSettings: (scope) =>
      Promise.resolve(
        scope === "global" ? loadGlobalSettingsSparse() : loadSettingsFor("."),
      ),
    saveSettings: (scope, updates) => {
      if (scope === "global") saveGlobalSettingsPatch(updates);
      else saveProjectSettingsPatchFor(".", updates);
      return Promise.resolve(loadSettingsFor("."));
    },
    requestRender: () => {},
  };
}

class MockPanel implements AuthPanel {
  inputActive = false;
  inputValue = "";
  cursor = 0;
  closed = false;
  closeMessage: string | undefined;

  close(message?: string): void {
    this.closed = true;
    this.closeMessage = message;
  }

  openInput(value = ""): void {
    this.inputActive = true;
    this.inputValue = value;
  }

  closeInput(): void {
    this.inputActive = false;
    this.inputValue = "";
  }

  resetCursor(): void {
    this.cursor = 0;
  }
}

function dialog(
  settings: Settings = {},
  initial = "",
): [AuthDialog, MockPanel] {
  const panel = new MockPanel();
  return [new AuthDialog(makeHost(), panel, settings, initial), panel];
}

test("main menu offers existing and custom", () => {
  const [d] = dialog();
  const values = d.page().items.map((i) => i.value);
  assertEquals(values, ["existing", "custom"]);
});

test(
  "existing opens the searchable provider list including presets",
  () => {
    const [d] = dialog();
    d.select("existing");
    const page = d.page();
    assertEquals(page.search, true);
    assert(page.items.some((i) => i.value === "provider:openai"));
  },
);

test(
  "selecting a provider opens its group list with all groups",
  () => {
    const [d] = dialog();
    d.select("existing");
    d.select("provider:openai");
    const values = d.page().items.map((i) => i.value);
    for (
      const expected of [
        "api-choice",
        "credentials",
        "protocol",
        "network",
        "advanced",
        "headers",
        "responses",
        "model-list",
        "done",
      ]
    ) {
      assert(values.includes(expected), `missing ${expected}`);
    }
  },
);

test(
  "custom provider requires an ID and rejects spaces",
  () => {
    const [d, panel] = dialog();
    d.select("custom");
    assertEquals(panel.inputActive, true);
    d.submit("bad id");
    assert(d.page().error !== undefined);
    d.submit("my-gateway");
    assertEquals(panel.inputActive, false);
    assertEquals(d.page().title, "dialog.auth.provider_title(my-gateway)");
  },
);

test("bool toggle flips forceHTTP11 in the draft", () => {
  const [d] = dialog();
  d.select("existing");
  d.select("provider:openai");
  d.select("network");
  d.select("field:provider:forceHTTP11");
  const row = d.page().items.find((i) =>
    i.value === "field:provider:forceHTTP11"
  );
  assertEquals(row?.description, "auth.value.yes");
});

test("tri-state cycles null → true → false → null", () => {
  const [d] = dialog();
  d.select("existing");
  d.select("provider:openai");
  d.select("advanced");
  const target = "field:provider:cacheControl";
  d.select(target);
  assertEquals(
    d.page().items.find((i) => i.value === target)?.description,
    "auth.value.on",
  );
  d.select(target);
  assertEquals(
    d.page().items.find((i) => i.value === target)?.description,
    "auth.value.off",
  );
  d.select(target);
  assertEquals(
    d.page().items.find((i) => i.value === target)?.description,
    "auth.value.auto",
  );
});

test(
  "adding a custom header prompts for key then value",
  () => {
    const [d] = dialog();
    d.select("existing");
    d.select("provider:openai");
    d.select("headers");
    d.select("header-add");
    d.submit("X-Team");
    d.submit("sac");
    const page = d.page();
    assert(
      page.items.some((i) => i.label === "X-Team" && i.description === "sac"),
    );
  },
);

test(
  "add model creates a draft editable through model groups",
  () => {
    const [d] = dialog();
    d.select("existing");
    d.select("provider:openai");
    d.select("model-list");
    d.select("model-add");
    d.submit("gpt-test");
    const values = d.page().items.map((i) => i.value);
    for (
      const expected of [
        "model-basics",
        "model-capabilities",
        "model-sampling",
        "model-cost",
        "model-compat",
      ]
    ) {
      assert(values.includes(expected), `missing ${expected}`);
    }
  },
);

test("duplicate model ID is rejected", () => {
  const [d] = dialog();
  d.select("existing");
  d.select("provider:openai");
  d.select("model-list");
  const existing = d.page().items.find((i) => i.value.startsWith("model:"));
  if (existing !== undefined) {
    d.select("model-add");
    d.submit(existing.value.slice("model:".length));
    assert(d.page().error !== undefined);
  }
});

test(
  "model cost fields appear only after cost is enabled",
  () => {
    const [d] = dialog();
    d.select("existing");
    d.select("provider:openai");
    d.select("model-list");
    d.select("model-add");
    d.submit("fresh-model");
    d.select("model-cost");
    assertEquals(
      d.page().items.some((i) => i.value === "field:model:costInput"),
      false,
    );
    d.select("field:model:costEnabled");
    const page = d.page();
    assert(page.items.some((i) => i.value === "field:model:costInput"));
    assert(page.items.some((i) => i.value === "field:model:costOutput"));
  },
);

test("esc steps back through the stack", () => {
  const [d] = dialog();
  d.select("existing");
  d.select("provider:openai");
  d.back();
  assertEquals(d.page().search, true); // back to provider list
});

test(
  "confirm persists the provider draft to global settings",
  async () => {
    const settings: Settings = {
      providers: {
        "my-provider": {
          api: "openai-chat",
          apiKey: "sk-old",
          baseUrl: "https://example.com/v1",
          models: [],
        } as ProviderConfig,
        "other-provider": {
          api: "openai-chat",
          apiKey: "sk-other-must-survive",
          baseUrl: "https://other.example.com/v1",
          models: [],
        } as ProviderConfig,
      },
    };
    // The confirm path merges against the on-disk sparse settings (mothx
    // semantics), so seed the isolated config dir first.
    Deno.writeTextFileSync(
      configDir() + "/settings.json",
      JSON.stringify(settings),
    );
    const [d, panel] = dialog(settings, "my-provider");
    d.select("credentials");
    d.select("field:provider:apiKey");
    d.submit("sk-brand-new-value");
    d.back();
    d.confirm();
    await settle();
    assertEquals(panel.closed, true);

    // Verify the sparse patch landed on disk with the edited key and preserved
    // untouched provider fields.
    const { loadGlobalSettingsSparse } = await import(
      "../config/settings.ts"
    );
    const saved = loadGlobalSettingsSparse();
    const provider = saved.providers?.["my-provider"];
    assertEquals(provider?.apiKey, "sk-brand-new-value");
    assertEquals(provider?.baseUrl, "https://example.com/v1");
    // Editing one provider must not wipe the others.
    assertEquals(
      saved.providers?.["other-provider"]?.apiKey,
      "sk-other-must-survive",
    );
  },
);

test(
  "initialProvider deep-links straight into the group list",
  () => {
    const [d] = dialog({}, "openai");
    const values = d.page().items.map((i) => i.value);
    assert(values.includes("credentials"));
  },
);

test("confirm with no models still closes cleanly", async () => {
  const [d, panel] = dialog();
  d.select("custom");
  d.submit("lonely-provider");
  d.confirm();
  await settle();
  assertEquals(panel.closed, true);
});

test(
  "invalid numeric input shows an error and stays in field",
  () => {
    const [d] = dialog({}, "openai");
    d.select("advanced");
    d.select("field:provider:maxImagesPerRequest");
    d.submit("abc");
    assert(d.page().error !== undefined);
  },
);

test("empty float resets the field to auto", () => {
  const [d] = dialog({}, "openai");
  d.select("model-list");
  const first = d.page().items.find((i) => i.value.startsWith("model:"));
  assert(first !== undefined);
  d.select(first.value);
  d.select("model-sampling");
  d.select("field:model:temperature");
  d.submit("0.7");
  d.select("field:model:temperature");
  d.submit("");
  const row = d.page().items.find((i) => i.value === "field:model:temperature");
  assertEquals(row?.description, "auto");
});

test(
  "field pages offer a confirm item that steps back one level",
  () => {
    const [d, panel] = dialog({}, "openai");
    d.select("network");
    assert(
      d.page().items.some((i) => i.value === "back"),
      "field page must offer the confirm-return item",
    );
    d.select("back");
    assertEquals(panel.closed, false);
    assert(
      d.page().items.some((i) => i.value === "network"),
      "the confirm item must return to the group list",
    );
    // Model field pages share the same affordance.
    d.select("model-list");
    const first = d.page().items.find((i) => i.value.startsWith("model:"));
    assert(first !== undefined);
    d.select(first.value);
    d.select("model-basics");
    assert(d.page().items.some((i) => i.value === "back"));
    d.select("back");
    assert(d.page().items.some((i) => i.value === "model-basics"));
  },
);
