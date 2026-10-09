// OpenSAC entry point (migrated from cmd/mothx). Thin process wrapper over the
// command tree in ./command.ts; the interactive TUI and remaining
// subcommands arrive with backlog slices #36/#37.

import "./platform/node_compat.ts";

import { createRootCommand } from "./cli/command.ts";
import { CommandError } from "./cli/command_parser.ts";
import { current as currentVersion } from "./version/version.ts";

if (import.meta.main) {
  try {
    await createRootCommand(currentVersion()).parse(Deno.args);
  } catch (error) {
    // A usage error ("Missing value for -r") is advice, not a crash: print one
    // actionable line and exit with its code. Re-throwing it showed users an
    // uncaught stack trace ending in the parser instead of the reason.
    if (error instanceof CommandError) {
      console.error(`error: ${error.message}`);
      Deno.exit(error.exitCode);
    }
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    Deno.exit(1);
  }
}
