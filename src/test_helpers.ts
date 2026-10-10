/** Test-only helpers for isolating process-wide environment state. */

import { runtime } from "./platform/runtime.ts";
import type { TestContext } from "./platform/runtime.ts";
import { test } from "#testing";

const CONFIG_DIR_ENV = "OPENSAC_DIR";

/** Runs a test body with a private OpenSAC config directory. */
export async function withIsolatedConfig<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = runtime.env.get(CONFIG_DIR_ENV);
  const configDir = runtime.makeTempDirSync({ prefix: "opensac-test-config-" });
  runtime.env.set(CONFIG_DIR_ENV, configDir);
  try {
    return await fn();
  } finally {
    if (previous === undefined) runtime.env.delete(CONFIG_DIR_ENV);
    else runtime.env.set(CONFIG_DIR_ENV, previous);
    runtime.removeSync(configDir, { recursive: true });
  }
}

/** Registers a test whose process-wide config state is isolated. */
export function testWithIsolatedConfig(
  name: string,
  fn: (context: TestContext) => void | Promise<void>,
): void {
  test(name, (context) => withIsolatedConfig(() => fn(context)));
}
