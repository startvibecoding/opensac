import * as path from "@opensac/path";

/** Project-level configuration directory name. */
export const projectDirName = ".opensac";

/** Returns a project-level path under .opensac in the current working directory. */
export function projectPath(...elem: string[]): string {
  return projectPathFor(".", ...elem);
}

/** Returns a project-level path under `cwd`/.opensac. */
export function projectPathFor(cwd: string, ...elem: string[]): string {
  if (cwd === "") cwd = ".";
  return path.join(cwd, projectDirName, ...elem);
}
