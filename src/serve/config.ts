// Ported from internal/serve/config.go.
//
// Initial slice of backlog #36: the serve.json path helpers. The full serve
// Config schema, load/normalize chain, and runtime wiring land with the rest of
// the serve package; doctor (backlog #32) only needs these paths so the
// diagnostic result renders the same serve config locations as the Go CLI/ACP.

import { configDir, projectPath } from "../config/mod.ts";
import path from "node:path";

/** Returns the global `serve.json` path. */
export function configPath(): string {
  return path.join(configDir(), "serve.json");
}

/** Returns the project-level `serve.json` path. */
export function projectConfigPath(): string {
  return projectPath("serve.json");
}
