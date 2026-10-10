import { runtime } from "../platform/runtime.ts";
import { runCoreCommand } from "../cli/core.ts";

if (import.meta.main) {
  const testPortValue = runtime.env.get("OPENSAC_TEST_FIXED_PORT");
  const testPort = Number(testPortValue ?? "0");
  await runCoreCommand(
    testPortValue !== undefined && Number.isInteger(testPort) && testPort >= 0
      ? {
          config: {
            host: "127.0.0.1",
            port: testPort,
            auth: false,
            passwords: [],
          },
        }
      : {},
  );
}
