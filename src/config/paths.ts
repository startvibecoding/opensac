// Ported from internal/config/paths.go

import * as path from "@std/path";

/** Project-level configuration directory name. */
export const ProjectDirName = ".mothx";

/** Returns a project-level path under .mothx in the current working directory. */
export function projectPath(...elem: string[]): string {
  return projectPathFor(".", ...elem);
}

/** Returns a project-level path under `cwd`/.mothx. */
export function projectPathFor(cwd: string, ...elem: string[]): string {
  if (cwd === "") cwd = ".";
  return path.join(cwd, ProjectDirName, ...elem);
}
