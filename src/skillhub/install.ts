// Ported from internal/skillhub/install.go
//
// Go's archive/zip is replaced with the local zip reader in ./zip.ts. The
// streaming copy limit is preserved by bounding the buffered download.

import * as path from "@std/path";
import { hasSkillFile, MetadataError, readMetadata } from "./local.ts";
import type {
  DownloadResult,
  DownloadSource,
  Market,
  MarketClient,
  SkillDetail,
  SkillId,
} from "./types.ts";
import { createZip, readZipEntries, type ZipWriteEntry } from "./zip.ts";

export const maxDownloadBytes = 50 << 20;
export const maxUnpackedBytes = 100 << 20;
export const maxFiles = 500;
export const maxFileBytes = 25 << 20;

/** Thrown when a directory already exists and is not SkillHub-managed. */
export class LocalSkillExistsError extends Error {
  constructor(
    message = "skill directory already exists and is not managed by SkillHub",
  ) {
    super(message);
    this.name = "LocalSkillExistsError";
  }
}

/** Thrown when an extracted skill archive is malformed or unsafe. */
export class InvalidArchiveError extends Error {
  constructor(message = "skill archive is invalid") {
    super(message);
    this.name = "InvalidArchiveError";
  }
}

export interface InstallRequest {
  market?: Market;
  id: string;
  version?: string;
  scope?: string;
  targetDir: string;
  overwrite?: boolean;
}

export interface InstallResult {
  name: string;
  market: Market;
  version: string;
  scope: string;
  dir: string;
  installed: boolean;
  alreadyInstalled?: boolean;
  warnings?: string[];
}

/** Installs a skill from a marketplace client into the target directory. */
export async function Install(
  signal: AbortSignal | undefined,
  client: MarketClient,
  request: InstallRequest,
): Promise<InstallResult> {
  if (!client) throw new Error("missing marketplace client");
  const market = request.market ?? client.market().id;
  if (market !== client.market().id) {
    throw new Error(
      `client market ${
        quote(client.market().id)
      } does not match requested market ${quote(market)}`,
    );
  }
  if (request.id === "" || request.targetDir === "") {
    throw new Error("skill id and target directory are required");
  }
  const id: SkillId = { market, id: request.id };
  const detail = await client.detail(signal, id);
  const version = request.version ?? detail.version;
  const name = installName(detail, request.id);
  const destination = path.join(request.targetDir, name);

  let existing: ReturnType<typeof readMetadata> | undefined;
  try {
    existing = readMetadata(destination);
  } catch (error) {
    if (!(error instanceof MetadataError)) throw error;
    if (exists(destination)) throw new LocalSkillExistsError();
  }
  if (existing) {
    if (existing.market !== market || existing.id !== request.id) {
      throw new Error(
        `skill ${
          quote(name)
        } is managed by ${existing.market}/${existing.id}, not ${market}/${request.id}`,
      );
    }
    if (existing.version === version) {
      return {
        name,
        market,
        version,
        scope: request.scope ?? "",
        dir: destination,
        installed: true,
        alreadyInstalled: true,
      };
    }
    if (!request.overwrite) {
      throw new Error(
        `skill ${quote(name)} is already installed; set overwrite to update`,
      );
    }
  }

  await Deno.mkdir(request.targetDir, { recursive: true });
  const download = await client.download(signal, id, version);
  const tempDir = await Deno.makeTempDir({
    dir: request.targetDir,
    prefix: ".skillhub-download-",
  });
  try {
    const archivePath = path.join(tempDir, "skill.zip");
    await copyLimited(archivePath, download.body, maxDownloadBytes);
    const extractDir = path.join(tempDir, "extract");
    await extractZip(archivePath, extractDir);
    const sourceDir = skillRoot(extractDir);
    const stageDir = path.join(tempDir, "install");
    await Deno.rename(sourceDir, stageDir);
    const metadata = {
      market,
      id: request.id,
      slug: detail.slug,
      version,
      installedAt: new Date().toISOString(),
      sourceUrl: download.meta.sourceUrl,
    };
    writeMetadata(stageDir, metadata);
    replaceDirectory(destination, stageDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
  return {
    name,
    market,
    version,
    scope: request.scope ?? "",
    dir: destination,
    installed: true,
  };
}

async function copyLimited(
  filePath: string,
  source: ReadableStream<Uint8Array>,
  limit: number,
): Promise<void> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total > limit) throw new Error(`download exceeds ${limit} byte limit`);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  await Deno.writeFile(filePath, buffer, { createNew: true, mode: 0o600 });
}

async function extractZip(archivePath: string, target: string): Promise<void> {
  const data = await Deno.readFile(archivePath);
  let entries;
  try {
    entries = readZipEntries(data);
  } catch (error) {
    throw new InvalidArchiveError(
      `skill archive is invalid: ${(error as Error).message}`,
    );
  }
  if (entries.length === 0 || entries.length > maxFiles) {
    throw new InvalidArchiveError(
      "skill archive is invalid: unsupported file count",
    );
  }
  let total = 0;
  for (const entry of entries) {
    archivePathSafe(entry.name);
    if (entry.isSymlink) {
      throw new InvalidArchiveError(
        "skill archive is invalid: symbolic links are not allowed",
      );
    }
    if (entry.uncompressedSize > maxFileBytes) {
      throw new InvalidArchiveError(
        `skill archive is invalid: file ${
          quote(entry.name)
        } exceeds size limit`,
      );
    }
    total += entry.uncompressedSize;
    if (total > maxUnpackedBytes) {
      throw new InvalidArchiveError(
        "skill archive is invalid: unpacked archive exceeds size limit",
      );
    }
  }
  await Deno.mkdir(target, { recursive: true });
  for (const entry of entries) {
    const entryPath = path.join(target, ...entry.name.split("/"));
    if (entry.isDir) {
      await Deno.mkdir(entryPath, { recursive: true });
      continue;
    }
    await Deno.mkdir(path.dirname(entryPath), { recursive: true });
    const content = await entry.read();
    if (content.length > maxFileBytes) {
      throw new InvalidArchiveError(
        `skill archive is invalid: file ${
          quote(entry.name)
        } exceeds size limit`,
      );
    }
    await Deno.writeFile(entryPath, content, { createNew: true, mode: 0o644 });
  }
}

function archivePathSafe(name: string): void {
  if (
    name === "" || name.includes("\\") || path.isAbsolute(name) ||
    isWindowsDrivePath(name)
  ) {
    throw new InvalidArchiveError(
      `skill archive is invalid: unsafe path ${quote(name)}`,
    );
  }
  const clean = path.normalize(name.split("/").join(path.SEPARATOR));
  if (
    clean === "." || clean === ".." ||
    clean.startsWith(".." + path.SEPARATOR)
  ) {
    throw new InvalidArchiveError(
      `skill archive is invalid: unsafe path ${quote(name)}`,
    );
  }
}

function isWindowsDrivePath(name: string): boolean {
  if (name.length < 2) return false;
  const c = name[0];
  const alpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
  return alpha && name[1] === ":";
}

function skillRoot(extractDir: string): string {
  if (hasSkillFile(extractDir)) return extractDir;
  const entries = [...Deno.readDirSync(extractDir)];
  if (entries.length === 1 && entries[0].isDirectory) {
    const root = path.join(extractDir, entries[0].name);
    if (hasSkillFile(root)) return root;
  }
  throw new InvalidArchiveError(
    "skill archive is invalid: SKILL.md is missing from archive root",
  );
}

function installName(detail: SkillDetail, id: string): string {
  let name = detail.slug;
  if (name === "") name = id;
  name = path.basename(name.split("\\").join("/"));
  if (
    name === "." || name === "" || name === ".." || name !== path.basename(name)
  ) {
    throw new Error(`invalid skill name ${quote(name)}`);
  }
  return name;
}

/** Writes install metadata into a skill directory. */
export function writeMetadata(
  dir: string,
  metadata: {
    market: Market;
    id: string;
    slug?: string;
    version: string;
    installedAt?: string;
    sourceUrl?: string;
  },
): void {
  const payload = JSON.stringify(
    {
      market: metadata.market,
      id: metadata.id,
      slug: metadata.slug ?? "",
      version: metadata.version,
      installedAt: metadata.installedAt ?? new Date().toISOString(),
      sourceURL: metadata.sourceUrl ?? "",
    },
    null,
    2,
  );
  Deno.writeTextFileSync(
    path.join(dir, ".opensac-skillhub.json"),
    payload + "\n",
  );
}

function replaceDirectory(destination: string, stage: string): void {
  Deno.mkdirSync(path.dirname(destination), { recursive: true });
  let backup = "";
  if (exists(destination)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(
      "T",
      "T",
    );
    backup = path.join(
      path.dirname(destination),
      ".backup",
      `${path.basename(destination)}-${stamp}`,
    );
    Deno.mkdirSync(path.dirname(backup), { recursive: true });
    Deno.renameSync(destination, backup);
  }
  try {
    Deno.renameSync(stage, destination);
  } catch (error) {
    if (backup !== "") Deno.renameSync(backup, destination);
    throw error;
  }
}

function exists(file: string): boolean {
  try {
    Deno.statSync(file);
    return true;
  } catch {
    return false;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// Re-exported so tests can build fixture archives without a dependency.
export { createZip, type ZipWriteEntry };

/** A downloaded archive plus its source metadata (re-export convenience). */
export type { DownloadResult, DownloadSource };
