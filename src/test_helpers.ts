/** Test-only helpers for isolating process-wide environment state. */

const CONFIG_DIR_ENV = "OPENSAC_DIR";

/** Runs a test body with a private OpenSAC config directory. */
export async function withIsolatedConfig<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = Deno.env.get(CONFIG_DIR_ENV);
  const configDir = Deno.makeTempDirSync({ prefix: "opensac-test-config-" });
  Deno.env.set(CONFIG_DIR_ENV, configDir);
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(CONFIG_DIR_ENV);
    else Deno.env.set(CONFIG_DIR_ENV, previous);
    Deno.removeSync(configDir, { recursive: true });
  }
}

/** Registers a Deno test whose process-wide config state is isolated. */
export function testWithIsolatedConfig(
  name: string,
  fn: (context: Deno.TestContext) => void | Promise<void>,
): void {
  Deno.test(name, (context) => withIsolatedConfig(() => fn(context)));
}
