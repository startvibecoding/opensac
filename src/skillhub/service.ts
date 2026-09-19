// Ported from internal/skillhub/service.go

import * as path from "@std/path";
import { projectSkillDirs } from "../skills/skills.ts";
import { MemoryCache, newMemoryCache } from "./cache.ts";
import { newClawHubClient } from "./clawhub.ts";
import {
  Install as installSkill,
  type InstallRequest,
  type InstallResult,
  LocalSkillExistsError,
} from "./install.ts";
import { LocalIndex, readMetadata, versionsDiffer } from "./local.ts";
import { newSkillHubClient } from "./skillhubcn.ts";
import type {
  Category,
  InstalledState,
  Market,
  MarketClient,
  MarketInfo,
  SearchPage,
  SearchQuery,
  SkillDetail,
  SkillId,
  SkillSummary,
  UserSkillsQuery,
} from "./types.ts";

/** Re-exported installer request/result types. */
export type { InstallRequest, InstallResult };

export class Service {
  private readonly clients = new Map<Market, MarketClient>();
  private readonly globalDir: string;
  private readonly projectDirs: string[];
  private readonly officialHandles: string[];
  private readonly cache: MemoryCache;

  constructor(
    globalDir: string,
    projectDirs: string[],
    officialHandles: string[],
    ...clients: MarketClient[]
  ) {
    const resolved = clients.length > 0
      ? clients
      : [newSkillHubClient("", undefined), newClawHubClient("", undefined)];
    for (const client of resolved) {
      if (client) this.clients.set(client.market().id, client);
    }
    this.globalDir = globalDir;
    this.projectDirs = projectDirs;
    this.officialHandles = officialHandles;
    this.cache = newMemoryCache(30_000);
  }

  /** Builds a service for a work directory's project skill dirs. */
  static forWorkDir(
    globalDir: string,
    workDir: string,
    officialHandles: string[],
    ...clients: MarketClient[]
  ): Service {
    return new Service(
      globalDir,
      projectSkillDirs(workDir),
      officialHandles,
      ...clients,
    );
  }

  markets(): MarketInfo[] {
    return [...this.clients.values()]
      .map((client) => client.market())
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async search(
    signal: AbortSignal | undefined,
    market: Market,
    query: SearchQuery,
  ): Promise<SearchPage> {
    const client = this.client(market);
    const key = `search:${market}:${queryKey(query)}`;
    const cached = this.cache.getPage(key);
    if (cached) {
      this.applyInstalled(cached.items);
      return cached;
    }
    const page = await client.search(signal, query);
    this.applyInstalled(page.items);
    this.cache.setPage(key, page);
    return page;
  }

  async categories(
    signal: AbortSignal | undefined,
    market: Market,
  ): Promise<Category[]> {
    const client = this.client(market);
    if (!client.market().capabilities.categories) return [];
    const key = "categories:" + market;
    const cached = this.cache.getCategories(key);
    if (cached) return cached;
    const categories = await client.categories(signal);
    this.cache.setCategories(key, categories);
    return categories;
  }

  async detail(
    signal: AbortSignal | undefined,
    market: Market,
    id: string,
  ): Promise<SkillDetail> {
    const client = this.client(market);
    const key = "detail:" + market + ":" + id;
    const cached = this.cache.getDetail(key);
    if (cached) {
      cached.installed = this.state(market, id) ?? null;
      return cached;
    }
    const skillId: SkillId = { market, id };
    const detail = await client.detail(signal, skillId);
    if (client.market().capabilities.fileList) {
      try {
        detail.files = await client.files(signal, skillId, detail.version);
      } catch {
        // ignore file-list failures
      }
    }
    if (client.market().capabilities.evaluation) {
      try {
        detail.evaluation = await client.evaluation(signal, skillId);
      } catch {
        // ignore evaluation failures
      }
    }
    detail.downloadSources = client.downloadSources(skillId, detail.version);
    detail.installed = this.state(market, id) ?? null;
    if (detail.installed) {
      detail.installed.updateAvailable = versionsDiffer(
        detail.installed.version ?? "",
        detail.version,
      );
    }
    this.cache.setDetail(key, detail);
    return detail;
  }

  async official(
    signal: AbortSignal | undefined,
    query: UserSkillsQuery,
  ): Promise<SearchPage> {
    const client = this.client("skillhub.cn");
    const pageSize = boundedLimit(query.limit);
    let pageNo = query.page ?? 0;
    if (pageNo < 1) pageNo = 1;
    const allItems: SkillSummary[] = [];
    const seen = new Set<string>();
    for (const handle of this.officialHandles) {
      for (let remotePage = 1;; remotePage++) {
        const page = await client.userSkills(signal, handle, {
          query: query.query,
          limit: 100,
          page: remotePage,
        });
        for (const item of page.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            allItems.push(item);
          }
        }
        if (remotePage * 100 >= (page.total ?? 0)) break;
      }
    }
    allItems.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    const start = Math.min((pageNo - 1) * pageSize, allItems.length);
    const end = Math.min(start + pageSize, allItems.length);
    const result: SearchPage = {
      items: allItems.slice(start, end),
      total: allItems.length,
      page: pageNo,
      pageSize,
    };
    this.applyInstalled(result.items);
    return result;
  }

  async install(
    signal: AbortSignal | undefined,
    request: InstallRequest,
  ): Promise<InstallResult> {
    const market = request.market ?? "skillhub.cn";
    request = { ...request, market };
    const client = this.client(market);
    if (!request.targetDir) throw new Error("target directory is required");
    this.validateTargetDir(request.targetDir, request.scope ?? "");
    const result = await installSkill(signal, client, request);
    this.cache.clear();
    return result;
  }

  private validateTargetDir(targetDir: string, scope: string): void {
    const target = path.resolve(path.normalize(targetDir));
    if (scope !== "project" && scope !== "global") {
      throw new Error("scope must be project or global");
    }
    if (scope === "global") {
      if (this.globalDir === "") {
        throw new Error("global skills directory is unavailable");
      }
      if (target !== path.resolve(path.normalize(this.globalDir))) {
        throw new Error(
          `global scope requires target directory ${
            JSON.stringify(this.globalDir)
          }`,
        );
      }
      return;
    }
    for (const root of this.projectDirs) {
      if (target === path.resolve(path.normalize(root))) return;
    }
    throw new Error(
      `target directory ${
        JSON.stringify(targetDir)
      } is not a configured project skills directory`,
    );
  }

  uninstall(market: Market, id: string, scope: string): void {
    const state = this.state(market, id);
    if (!state || !state.installed) {
      throw new Error(`skill ${JSON.stringify(id)} is not installed`);
    }
    if (state.local) throw new LocalSkillExistsError();
    if (scope !== "" && scope !== state.scope) {
      throw new Error(
        `skill ${JSON.stringify(id)} is not installed in ${scope} scope`,
      );
    }
    let metadata;
    try {
      metadata = readMetadata(state.dir);
    } catch {
      throw new Error(
        `managed metadata for skill ${JSON.stringify(id)} is invalid`,
      );
    }
    if (metadata.market !== market || metadata.id !== id) {
      throw new Error(
        `managed metadata for skill ${JSON.stringify(id)} is invalid`,
      );
    }
    this.validateSkillDir(state.dir);
    let info: Deno.FileInfo;
    try {
      info = Deno.lstatSync(state.dir);
    } catch (error) {
      throw error;
    }
    if (info.isSymlink) {
      throw new Error("refusing to uninstall a symbolic link");
    }
    Deno.removeSync(state.dir, { recursive: true });
    this.cache.clear();
  }

  private validateSkillDir(dir: string): void {
    const target = path.resolve(path.normalize(dir));
    const roots = [...this.projectDirs];
    if (this.globalDir !== "") roots.push(this.globalDir);
    for (const root of roots) {
      const rel = path.relative(path.resolve(path.normalize(root)), target);
      if (
        rel !== "" && rel !== "." && rel !== ".." &&
        !rel.startsWith(".." + path.SEPARATOR)
      ) {
        return;
      }
    }
    throw new Error(
      `skill directory ${
        JSON.stringify(dir)
      } is outside configured skills directories`,
    );
  }

  async showcase(
    signal: AbortSignal | undefined,
    market: Market,
    kind: string,
    query: SearchQuery,
  ): Promise<SearchPage> {
    const client = this.client(market);
    if (typeof client.showcase !== "function") {
      throw new Error(
        `market ${JSON.stringify(market)} does not support showcase`,
      );
    }
    const page = await client.showcase(signal, kind, query);
    this.applyInstalled(page.items);
    return page;
  }

  async fileContent(
    signal: AbortSignal | undefined,
    market: Market,
    id: string,
    version: string,
    filePath: string,
  ): Promise<string> {
    const client = this.client(market);
    if (typeof client.fileContent !== "function") {
      throw new Error(
        `market ${JSON.stringify(market)} does not support file content`,
      );
    }
    return await client.fileContent(signal, { market, id }, version, filePath);
  }

  async installSkillSet(
    signal: AbortSignal | undefined,
    requests: InstallRequest[],
  ): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const installed: InstallResult[] = [];
    for (const request of requests) {
      let result: InstallResult;
      try {
        result = await this.install(signal, request);
      } catch (error) {
        for (let i = installed.length - 1; i >= 0; i--) {
          try {
            this.uninstall(
              installed[i].market,
              installed[i].name,
              installed[i].scope,
            );
          } catch {
            // best-effort rollback
          }
        }
        throw error;
      }
      results.push(result);
      if (!result.alreadyInstalled) installed.push(result);
    }
    return results;
  }

  private client(market: Market): MarketClient {
    const client = this.clients.get(market);
    if (!client) {
      throw new Error(`unsupported skill market ${JSON.stringify(market)}`);
    }
    return client;
  }

  private state(market: Market, id: string): InstalledState | undefined {
    try {
      const index = new LocalIndex(this.globalDir, this.projectDirs);
      return index.state(market, id);
    } catch {
      return undefined;
    }
  }

  private applyInstalled(items: SkillSummary[]): void {
    try {
      const index = new LocalIndex(this.globalDir, this.projectDirs);
      index.apply(items);
    } catch {
      // ignore index failures
    }
  }
}

function boundedLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return 20;
  if (limit > 100) return 100;
  return limit;
}

function queryKey(query: SearchQuery): string {
  return JSON.stringify({
    query: query.query ?? "",
    limit: query.limit ?? 0,
    page: query.page ?? 0,
    cursor: query.cursor ?? "",
    sort: query.sort ?? "",
    order: query.order ?? "",
    category: query.category ?? "",
    author: query.author ?? "",
    verifiedOnly: query.verifiedOnly ?? false,
    nonSuspiciousOnly: query.nonSuspiciousOnly ?? false,
  });
}
