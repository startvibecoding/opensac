// Example: run the public agent SDK against a built-in provider.
//
//   OPENAI_API_KEY=sk-... deno run -A examples/builtin_provider.ts
//
// `withProviderByName` resolves the vendor through the provider registry that
// the repository's `bootstrap.ts` facade registers (the same hook the CLI/TUI
// use). Swap the vendor/baseURL for anthropic or any OpenAI-compatible
// endpoint.

import { eventAgentEnd, eventTextDelta, newBuilder } from "../sdk/agent/mod.ts";
import "../bootstrap.ts";

const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
if (apiKey === "") {
  console.error("set OPENAI_API_KEY before running this example");
  Deno.exit(1);
}

const agent = newBuilder()
  .withProviderByName("openai", "https://api.openai.com/v1", "openai", apiKey)
  .withModel("gpt-4o-mini")
  .withMode("yolo")
  .withWorkDir(Deno.cwd())
  .build();

for await (const event of agent.run("Reply with exactly: ok")) {
  if (event.type === eventTextDelta) {
    Deno.stdout.writeSync(new TextEncoder().encode(event.textDelta ?? ""));
  } else if (event.type === eventAgentEnd) {
    console.log("\n[agent finished]");
  }
}
