// Ported from internal/skillhub/local.go

import * as path from "@std/path";
import type { InstalledState, Market, SkillSummary } from "./types.ts";

/** Name of the per-skill install metadata file. */
export const metadataFileName = ".mothx-skillhub.json";

export interface InstallMetadata {
  market: Market;
  id: string;
  slug: string;
  version: string;
  installedAt: string;
  sourceUrl: string;
}

/** Thrown when a local install metadata file is missing or invalid. */
export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

export class LocalIndex {
  private entries = new Map<string, InstalledState>();

  constructor(globalDir: string, projectDirs: string[]) {
    this.scan(globalDir, "global");
    // First project directory has the highest priority.
    for (const dir of projectDirs) this.scan(dir, "project");
  }

  private scan(root: string, scope: string): void {
    if (root === "") return;
    let dirEntries: Deno.DirEntry[];
    try {
      dirEntries = [...Deno.readDirSync(root)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory) continue;
      const dir = path.join(root, entry.name);
      let metadata: InstallMetadata | undefined;
      try {
        metadata = readMetadata(dir);
      } catch {
        metadata = undefined;
      }
      if (metadata) {
        const key = installedKey(metadata.market, metadata.id);
        if (!this.entries.has(key)) {
          this.entries.set(key, {
            installed: true,
            scope,
            dir,
            market: metadata.market,
            id: metadata.id,
            name: entry.name,
            version: metadata.version,
          });
        }
        continue;
      }
      if (!hasSkillFile(dir)) continue;
      const key = localInstalledKey(dir);
      if (!this.entries.has(key)) {
        this.entries.set(key, {
          installed: true,
          scope,
          dir,
          name: entry.name,
          local: true,
        });
      }
    }
  }

  state(market: Market, id: string): InstalledState | undefined {
    const state = this.entries.get(installedKey(market, id));
    return state ? { ...state } : undefined;
  }

  apply(items: SkillSummary[]): void {
    for (const item of items) {
      let state = this.state(item.market, item.id);
      if (!state) state = this.localState(item);
      if (state) {
        state.updateAvailable = !state.local &&
          versionsDiffer(state.version ?? "", item.version);
      }
      item.installed = state ?? null;
    }
  }

  private localState(item: SkillSummary): InstalledState | undefined {
    for (const state of this.entries.values()) {
      if (
        state.local &&
        (state.name === item.slug || state.name === item.name ||
          state.name === item.displayName)
      ) {
        return { ...state };
      }
    }
    return undefined;
  }

  list(): InstalledState[] {
    const out = [...this.entries.values()].map((s) => ({ ...s }));
    out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    return out;
  }
}

/** Builds a local install index over the global and project skill dirs. */
export function newLocalIndex(
  globalDir: string,
  projectDirs: string[],
): LocalIndex {
  return new LocalIndex(globalDir, projectDirs);
}

export function installedKey(market: Market, id: string): string {
  return `${market}\x00${id}`;
}

export function localInstalledKey(dir: string): string {
  return `local\x00${path.normalize(dir)}`;
}

/** Reads and validates a skill's install metadata. */
export function readMetadata(dir: string): InstallMetadata {
  const file = path.join(dir, metadataFileName);
  let raw: string;
  try {
    raw = Deno.readTextFileSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new MetadataError(`metadata not found: ${file}`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MetadataError(`invalid metadata: ${file}`);
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const marketRaw = typeof obj.market === "string" ? obj.market : "";
  const metadata: InstallMetadata = {
    market: marketRaw as Market,
    id: typeof obj.id === "string" ? obj.id : "",
    slug: typeof obj.slug === "string" ? obj.slug : "",
    version: typeof obj.version === "string" ? obj.version : "",
    installedAt: typeof obj.installedAt === "string" ? obj.installedAt : "",
    sourceUrl: typeof obj.sourceURL === "string"
      ? obj.sourceURL
      : typeof obj.sourceUrl === "string"
      ? obj.sourceUrl
      : "",
  };
  if (marketRaw.trim() === "" || metadata.id.trim() === "") {
    throw new MetadataError(`invalid metadata: ${file}`);
  }
  return metadata;
}

/** Reports whether a directory contains a skill entry file. */
export function hasSkillFile(dir: string): boolean {
  if (exists(path.join(dir, "SKILL.md"))) return true;
  return exists(path.join(dir, "skill.md"));
}

function exists(file: string): boolean {
  try {
    Deno.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Compares two non-empty versions. */
export function versionsDiffer(installed: string, remote: string): boolean {
  return installed !== "" && remote !== "" && installed !== remote;
}
