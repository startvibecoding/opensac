import { assertEquals, assertStrictEquals } from "@std/assert";
import * as path from "@std/path";
import {
  defaultSettings,
  type ModelConfig,
  projectDirName,
  type ProviderConfig,
  saveGlobalSettings,
  type Settings,
} from "../config/mod.ts";
import {
  type Check,
  type Response,
  run,
  STATUS_ERROR,
  STATUS_OK,
  validateProvider,
} from "./doctor.ts";

function withEnv(name: string, value: string, fn: () => void): void {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

function checkByID(result: Response, id: string): Check {
  for (const check of result.checks) {
    if (check.id === id) return check;
  }
  throw new Error(`missing check ${id} in ${JSON.stringify(result.checks)}`);
}

Deno.test("RunReportsMissingProviderKeyWithoutLeakingConfiguredValue", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = defaultSettings();
    settings.defaultProvider = "doctor-test";
    settings.defaultModel = "model";
    settings.providers = {
      "doctor-test": {
        apiKey: "${DOCTOR_TEST_API_KEY}",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-chat",
        models: [{ id: "model", name: "Model" }],
      },
    };
    saveGlobalSettings(settings);
    const result = run(workDir, "test-version");
    assertStrictEquals(result.ok, false);
    const providerCheck = checkByID(result, "provider.default");
    assertEquals(providerCheck.status, STATUS_ERROR);
    assertEquals(providerCheck.detail, "doctor-test: missing API key");
    assertEquals(
      providerCheck.fix,
      "Set doctor-test.apiKey or DOCTOR_TEST_API_KEY",
    );
  });
});

Deno.test("RunUsesProjectSettingsForRequestedCWD", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const projectDir = path.join(workDir, projectDirName);
    Deno.mkdirSync(projectDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(projectDir, "settings.json"),
      `{
  "defaultProvider": "project-provider",
  "defaultModel": "model",
  "providers": {
    "project-provider": {
      "apiKey": "project-key",
      "baseUrl": "http://127.0.0.1:1/v1",
      "api": "openai-chat",
      "models": [{"id": "model"}]
    }
  }
}`,
    );
    const result = run(workDir, "test-version");
    assertEquals(
      checkByID(result, "provider.default").detail,
      "project-provider",
    );
  });
});

Deno.test("ValidateProviderReportsMissingModelWhenNoModelCanBeSelected", () => {
  const settings: Settings = defaultSettings();
  settings.defaultProvider = "doctor-empty-models";
  settings.defaultModel = "";
  settings.providers = {
    "doctor-empty-models": {
      apiKey: "configured-key",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-chat",
      models: [],
    } satisfies ProviderConfig,
  };

  const checks = validateProvider(
    settings,
    settings.defaultProvider,
    settings.defaultModel,
  );
  assertEquals(checks.length, 2);
  assertEquals(checks[0].id, "provider.default");
  assertEquals(checks[0].status, STATUS_OK);
  assertEquals(checks[1].id, "model.default");
  assertEquals(checks[1].status, STATUS_ERROR);
});

Deno.test("RunNeverSerializesAPIKey", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const apiKey = "doctor-test-secret-value";
    const settings = defaultSettings();
    settings.defaultProvider = "doctor-secret";
    settings.defaultModel = "model";
    settings.providers = {
      "doctor-secret": {
        apiKey: apiKey,
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-chat",
        models: [{ id: "model", name: "Model" } satisfies ModelConfig],
      },
    };
    saveGlobalSettings(settings);

    const data = JSON.stringify(run(workDir, "test-version"));
    assertStrictEquals(data.includes(apiKey), false);
  });
});
