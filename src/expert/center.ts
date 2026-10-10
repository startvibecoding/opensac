import * as path from "../compat/path.ts";
import { projectPathFor } from "../config/mod.ts";
import { configDir } from "../platform/platform.ts";
import { builtinFS } from "./builtin.ts";
import {
  type Bundle,
  sourceBuiltin,
  sourceGlobal,
  sourceProject,
} from "./expert.ts";
import { type LocalizedText, type Summary } from "./expert.ts";
import {
  loadBundle,
  loadBundleFS,
  manifestFileName,
  normalizeManifest,
  validateManifest,
} from "./bundle.ts";

/** Returns the global experts directory (<configDir>/experts). */
export function globalExpertsDir(): string {
  return path.join(configDir(), "experts");
}

/**
 * Resolves expert bundles from three layered sources with name shadowing:
 * project > global > builtin. Scans are lazy (per call), so users can drop a
 * bundle into a directory and it takes effect without a watcher.
 */
export class Center {
  /** Project root for the project-level source; empty disables that layer. */
  projectDir: string;

  constructor(projectDir = "") {
    this.projectDir = projectDir;
  }

  /** Returns <ProjectDir>/.opensac/experts, or "" when the layer is disabled. */
  projectExpertsDir(): string {
    if (this.projectDir.trim() === "") return "";
    return projectPathFor(this.projectDir, "experts");
  }

  /**
   * Lazily scans all three layers and returns summaries sorted by name.
   * Higher-priority layers shadow lower ones with the same bundle name.
   */
  list(): Summary[] {
    const summaries = new Map<string, Summary>();
    // builtin (lowest priority; later layers overwrite by name)
    for (const entry of builtinFS.readDir(".") ?? []) {
      if (!entry.isDir) continue;
      const name = entry.name;
      const data = builtinFS.readFile(name + "/" + manifestFileName);
      if (data === undefined) continue;
      summaries.set(name, summaryFromManifest(name, sourceBuiltin, data));
    }
    // global
    for (const summary of listOSLayer(globalExpertsDir(), sourceGlobal)) {
      summaries.set(summary.name, summary);
    }
    // project (highest priority)
    const projectDir = this.projectExpertsDir();
    if (projectDir !== "") {
      for (const summary of listOSLayer(projectDir, sourceProject)) {
        summaries.set(summary.name, summary);
      }
    }
    return [...summaries.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }

  /**
   * Loads the highest-priority bundle with the given name. A bundle that fails
   * validation is returned with invalid/invalidReason set (no error).
   */
  get(name: string): Bundle {
    validateBundleNameOrThrow(name);
    const projectDir = this.projectExpertsDir();
    if (projectDir !== "") {
      const bundleDir = path.join(projectDir, name);
      if (isFile(path.join(bundleDir, manifestFileName))) {
        return loadBundle(bundleDir);
      }
    }
    const globalDir = path.join(globalExpertsDir(), name);
    if (isFile(path.join(globalDir, manifestFileName))) {
      return loadBundle(globalDir);
    }
    if (builtinFS.stat(name + "/" + manifestFileName) !== undefined) {
      return loadBundleFS(builtinFS, name);
    }
    throw new Error(`expert ${quote(name)} not found`);
  }
}

/**
 * Rejects empty names and path traversal so a layer lookup can never escape its
 * experts directory.
 */
export function validateBundleName(name: string): string | null {
  if (name.trim() === "") return "expert name 不能为空";
  if (
    name !== path.basename(name) || name.includes("/") || name.includes("\\") ||
    name === "." || name === ".."
  ) {
    return `invalid expert name ${quote(name)}`;
  }
  return null;
}

export function validateBundleNameOrThrow(name: string): void {
  const reason = validateBundleName(name);
  if (reason !== null) throw new Error(reason);
}

export function listOSLayer(dir: string, source: string): Summary[] {
  if (dir === "") return [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return []; // missing/unreadable directory = empty layer
  }
  const out: Summary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const name = entry.name;
    let data: string;
    try {
      data = Deno.readTextFileSync(path.join(dir, name, manifestFileName));
    } catch {
      continue; // no expert.json: not an expert bundle
    }
    out.push(summaryFromManifest(name, source, data));
  }
  return out;
}

/**
 * Builds a Summary from raw expert.json text. Manifest parse failures and
 * manifest-level validation failures are flagged invalid with a reason.
 */
export function summaryFromManifest(
  dirName: string,
  source: string,
  data: string,
): Summary {
  let manifest;
  try {
    manifest = normalizeManifest(JSON.parse(data));
  } catch (err) {
    return {
      name: dirName,
      expertType: "",
      displayName: { zh: "", en: "" } as LocalizedText,
      source,
      invalid: true,
      invalidReason: `${manifestFileName} 解析失败: ${err}`,
    };
  }
  const summary: Summary = {
    name: dirName,
    expertType: manifest.expertType,
    displayName: manifest.displayName,
    source,
    invalid: false,
  };
  const reason = validateManifest(manifest, dirName);
  if (reason !== "") {
    summary.invalid = true;
    summary.invalidReason = reason;
  }
  return summary;
}

function isFile(p: string): boolean {
  try {
    return !Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function quote(s: string): string {
  return JSON.stringify(s);
}
