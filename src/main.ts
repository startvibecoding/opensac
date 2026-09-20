// MothX entry point (migrated from cmd/mothx). Thin process wrapper over the
// Cliffy command tree in ./command.ts; the interactive TUI and remaining
// subcommands arrive with backlog slices #36/#37.

import { newRootCommand } from "./cli/command.ts";
import { current as currentVersion } from "./version/version.ts";

if (import.meta.main) {
  try {
    await newRootCommand(currentVersion()).parse(Deno.args);
  } catch (error) {
    if (error instanceof Error) {
      if ("exitCode" in error) throw error; // Cliffy usage errors
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    Deno.exit(1);
  }
}
