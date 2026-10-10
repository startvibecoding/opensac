import { assert, assertEquals } from "../compat/assert.ts";
import {
  modelsEndpoint,
  parseDiscoveredModels,
  resolveSecretRef,
} from "./mod.ts";
import { test } from "#testing";

test("ModelsEndpoint", () => {
  const tests: Array<[string, string]> = [
    ["https://api.example.test/v1", "https://api.example.test/v1/models"],
    ["https://api.example.test/v1/", "https://api.example.test/v1/models"],
    [
      "https://api.example.test/v1/models",
      "https://api.example.test/v1/models",
    ],
  ];
  for (const [base, want] of tests) {
    assertEquals(modelsEndpoint(base), want, base);
  }
  for (const base of ["", "ftp://example.test/v1", "/relative"]) {
    assert(
      (() => {
        try {
          modelsEndpoint(base);
          return false;
        } catch {
          return true;
        }
      })(),
      base,
    );
  }
});

test("ParseDiscoveredModels", () => {
  const got = parseDiscoveredModels(
    `{"models":[{"name":"models/gemini-2.0-flash","displayName":"Gemini 2.0 Flash"},{"name":"models/gemini-2.0-flash"},{"id":"gpt-4o","context_length":128000,"max_output_tokens":4096,"input_modalities":["text","image"]}]}`,
  );
  assertEquals(got.length, 2);
  assertEquals(got[0].id, "gemini-2.0-flash");
  assertEquals(got[0].name, "Gemini 2.0 Flash");
  assertEquals(got[1].id, "gpt-4o");
  assertEquals(got[1].contextWindow, 128000);
  assertEquals(got[1].maxTokens, 4096);
  assertEquals(got[1].input?.length, 2);
});

test("ParseDiscoveredModelsBareArray", () => {
  const got = parseDiscoveredModels(
    `[{"id":"a"},{"id":"b","reasoning":true},{"id":"a"}]`,
  );
  assertEquals(got.length, 2);
  assertEquals(got[0].id, "a");
  assertEquals(got[0].reasoning, false);
  assertEquals(got[1].id, "b");
  assertEquals(got[1].reasoning, true);
  assertEquals(got[0].input, ["text"]);
});

test("ResolveSecretRef", () => {
  Deno.env.set("OPENSAC_DISCOVER_TEST_KEY", "from-env");
  try {
    assertEquals(resolveSecretRef("${OPENSAC_DISCOVER_TEST_KEY}"), "from-env");
    assertEquals(resolveSecretRef(" literal "), "literal");
  } finally {
    Deno.env.delete("OPENSAC_DISCOVER_TEST_KEY");
  }
});
