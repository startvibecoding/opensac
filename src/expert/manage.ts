import { runtime } from "../platform/runtime.ts";
import type { DirEntry, FileInfo } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { type Manifest, sourceGlobal, sourceProject } from "./expert.ts";
import { agentsDirName, loadBundle, manifestFileName } from "./bundle.ts";
import {
  Center,
  globalExpertsDir,
  listOSLayer,
  validateBundleNameOrThrow,
} from "./center.ts";
import { type Summary } from "./expert.ts";

/**
 * Identifies the writable expert layer. Builtin bundles deliberately do not
 * have a scope: they are packaged with the binary and always read-only.
 */
export type Scope = string;
export const SCOPE_GLOBAL: Scope = sourceGlobal;
export const SCOPE_PROJECT: Scope = sourceProject;

/**
 * The editable representation of an expert bundle. Agent values are complete
 * agents/<id>.md source files (including frontmatter).
 */
export interface ManagedBundle {
  scope: Scope;
  manifest: Manifest;
  agents: Record<string, string>;
}

/**
 * Owns safe CRUD for the two user-writable bundle layers. projectDir is
 * required only for project scope. globalDir is primarily injectable for tests.
 */
export class Manager {
  projectDir: string;
  globalDir: string;

  constructor(projectDir = "") {
    this.projectDir = projectDir;
    this.globalDir = "";
  }

  /** Returns the effective, shadow-resolved catalog used by SessionRuntime. */
  list(): Summary[] {
    return new Center(this.projectDir).list();
  }

  /** Returns bundles physically present in one writable layer. */
  listScope(scope: Scope): Summary[] {
    const dir = this.scopeDir(scope);
    return listOSLayer(dir, scope).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /** Reads a bundle from exactly the requested writable layer. */
  get(scope: Scope, name: string): ManagedBundle {
    validateBundleNameOrThrow(name);
    const dir = this.scopeDir(scope);
    const bundleDir = path.join(dir, name);
    if (!isFile(path.join(bundleDir, manifestFileName))) {
      throw new Error(`${scope} expert ${quote(name)} not found`);
    }
    const bundle = loadBundle(bundleDir);
    if (bundle.invalid) {
      throw new Error(
        `expert bundle ${quote(name)} is invalid: ${bundle.invalidReason}`,
      );
    }
    const agents = readAgentSources(bundleDir);
    return { scope, manifest: bundle.manifest, agents };
  }

  /** Validates and atomically publishes a new bundle. */
  create(scope: Scope, draft: ManagedBundle): ManagedBundle {
    const { name, dir } = this.validateDraftScope(scope, draft);
    if (existsSync(path.join(dir, name))) {
      throw new Error(`${scope} expert ${quote(name)} already exists`);
    }
    this.publish(dir, name, draft, false);
    return this.get(scope, name);
  }

  /** Replaces exactly one existing global/project bundle. */
  update(scope: Scope, draft: ManagedBundle): ManagedBundle {
    const { name, dir } = this.validateDraftScope(scope, draft);
    const target = path.join(dir, name);
    let info: FileInfo | null = null;
    try {
      info = runtime.statSync(target);
    } catch (err) {
      if (err instanceof runtime.errors.NotFound) {
        throw new Error(`${scope} expert ${quote(name)} not found`);
      }
      throw new Error(`inspect expert ${quote(name)}: ${err}`);
    }
    if (!info.isDirectory) {
      throw new Error(`${scope} expert ${quote(name)} is not a directory`);
    }
    this.publish(dir, name, draft, true);
    return this.get(scope, name);
  }

  /** Removes exactly one user-owned bundle directory. */
  delete(scope: Scope, name: string): void {
    validateBundleNameOrThrow(name);
    const dir = this.scopeDir(scope);
    const target = path.join(dir, name);
    let info: FileInfo | null = null;
    try {
      info = runtime.statSync(target);
    } catch (err) {
      if (err instanceof runtime.errors.NotFound) {
        throw new Error(`${scope} expert ${quote(name)} not found`);
      }
      throw new Error(`inspect expert ${quote(name)}: ${err}`);
    }
    if (!info.isDirectory) {
      throw new Error(`${scope} expert ${quote(name)} is not a directory`);
    }
    runtime.removeSync(target, { recursive: true });
  }

  scopeDir(scope: Scope): string {
    switch (scope) {
      case SCOPE_GLOBAL:
        if (this.globalDir.trim() !== "") {
          return path.normalize(this.globalDir);
        }
        return globalExpertsDir();
      case SCOPE_PROJECT: {
        const dir = new Center(this.projectDir).projectExpertsDir();
        if (dir === "") {
          throw new Error(
            "project scope requires an absolute workspace directory",
          );
        }
        return dir;
      }
      default:
        throw new Error(
          `expert scope ${quote(
            scope,
          )} is not writable; builtin experts are read-only`,
        );
    }
  }

  private validateDraftScope(
    scope: Scope,
    draft: ManagedBundle,
  ): { name: string; dir: string } {
    if (
      draft.scope !== "" &&
      draft.scope !== undefined &&
      draft.scope !== scope
    ) {
      throw new Error(
        `bundle scope ${quote(draft.scope)} does not match requested scope ${quote(
          scope,
        )}`,
      );
    }
    const name = draft.manifest.name.trim();
    validateBundleNameOrThrow(name);
    const dir = this.scopeDir(scope);
    return { name, dir };
  }

  private publish(
    parent: string,
    name: string,
    draft: ManagedBundle,
    replace: boolean,
  ): void {
    runtime.mkdirSync(parent, { recursive: true });
    const tmpRoot = runtime.makeTempDirSync({
      dir: parent,
      prefix: ".expert-write-",
    });
    try {
      const staged = path.join(tmpRoot, name);
      writeManagedBundle(staged, draft);
      const validated = loadBundle(staged);
      if (validated.invalid) {
        throw new Error(`expert bundle is invalid: ${validated.invalidReason}`);
      }
      const target = path.join(parent, name);
      if (!replace) {
        runtime.renameSync(staged, target);
        return;
      }
      const backup = path.join(tmpRoot, ".previous");
      runtime.renameSync(target, backup);
      try {
        runtime.renameSync(staged, target);
      } catch (err) {
        try {
          runtime.renameSync(backup, target);
        } catch {
          // best-effort restore
        }
        throw new Error(`publish expert bundle: ${err}`);
      }
    } finally {
      try {
        runtime.removeSync(tmpRoot, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function readAgentSources(bundleDir: string): Record<string, string> {
  let entries: DirEntry[];
  try {
    entries = [...runtime.readDirSync(path.join(bundleDir, agentsDirName))];
  } catch (err) {
    throw new Error(`read agents directory: ${err}`);
  }
  const agents: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    validateAgentIDOrThrow(id);
    try {
      agents[id] = runtime.readTextFileSync(
        path.join(bundleDir, agentsDirName, entry.name),
      );
    } catch (err) {
      throw new Error(`read agent ${quote(id)}: ${err}`);
    }
  }
  return agents;
}

function validateAgentIDOrThrow(id: string): void {
  const reason = validateAgentID(id);
  if (reason !== null) throw new Error(reason);
}

/** Rejects empty ids and path traversal in an agents/<id>.md file name. */
export function validateAgentID(id: string): string | null {
  if (
    id.trim() === "" ||
    id !== path.basename(id) ||
    id.includes("/") ||
    id.includes("\\") ||
    id === "." ||
    id === ".."
  ) {
    return `invalid agent id ${quote(id)}`;
  }
  return null;
}

function writeManagedBundle(dir: string, draft: ManagedBundle): void {
  runtime.mkdirSync(path.join(dir, agentsDirName), { recursive: true });
  const data = JSON.stringify(draft.manifest, null, 2);
  runtime.writeTextFileSync(path.join(dir, manifestFileName), data + "\n");
  for (const [id, source] of Object.entries(draft.agents)) {
    validateAgentIDOrThrow(id);
    runtime.writeTextFileSync(
      path.join(dir, agentsDirName, id + ".md"),
      source,
    );
  }
}

function existsSync(p: string): boolean {
  try {
    runtime.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return !runtime.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function quote(s: string): string {
  return JSON.stringify(s);
}
