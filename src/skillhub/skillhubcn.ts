import {
  boundedLimit,
  download as downloadStream,
  endpoint,
  filterSkills,
} from "./client_helpers.ts";
import { parseTags, parseVersion } from "./clawhub.ts";
import { createHTTPClient, getJSON, type HttpClient } from "./http.ts";
import {
  type Category,
  type DownloadResult,
  type DownloadSource,
  type MarketClient,
  type MarketInfo,
  type SearchPage,
  type SearchQuery,
  type SkillDetail,
  type SkillFile,
  type SkillId,
  type SkillSummary,
  type UserSkillsQuery,
} from "./types.ts";

export const skillHubDefaultURL = "https://api.skillhub.cn";
export const skillHubDownloadBaseURL =
  "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com";

export class SkillHubClient implements MarketClient {
  private readonly baseURL: string;
  private readonly downloadURL: string;
  private readonly httpClient: HttpClient;

  constructor(baseURL?: string, client?: HttpClient) {
    this.baseURL = trimRight(baseURL || skillHubDefaultURL, "/");
    this.downloadURL = skillHubDownloadBaseURL;
    this.httpClient = createHTTPClient(client);
  }

  market(): MarketInfo {
    return {
      id: "skillhub.cn",
      name: "SkillHub.cn",
      siteUrl: "https://skillhub.cn",
      capabilities: {
        search: true,
        list: true,
        cursorPagination: false,
        pagePagination: true,
        categories: true,
        showcase: true,
        authorFilter: false,
        userSkills: true,
        fileList: true,
        fileContent: false,
        evaluation: true,
      },
    };
  }

  async search(
    signal: AbortSignal | undefined,
    q: SearchQuery,
  ): Promise<SearchPage> {
    const limit = boundedLimit(q.limit);
    if ((q.query ?? "").trim() !== "") {
      const response = await getJSON<{ results?: unknown[] }>(
        this.httpClient,
        endpoint(this.baseURL, "/api/v1/search", {
          q: [q.query ?? ""],
          limit: [String(limit)],
        }),
        signal,
      );
      const items = (response.results ?? []).map((raw) =>
        skillHubItemSummary(parseSkillHubItem(raw)),
      );
      return { items, total: items.length, page: 1, pageSize: limit };
    }
    const page = Math.max(1, q.page ?? 1);
    const values: Record<string, string[]> = {
      page: [String(page)],
      pageSize: [String(limit)],
    };
    if (q.category) values.category = [q.category];
    if (q.sort) values.sortBy = [q.sort];
    if (q.order) values.order = [q.order];
    const response = await getJSON<{
      code?: number;
      message?: string;
      data?: { total?: number; skills?: unknown[] };
    }>(this.httpClient, endpoint(this.baseURL, "/api/skills", values), signal);
    if ((response.code ?? 0) !== 0) {
      throw new Error(`SkillHub list: ${response.message ?? ""}`);
    }
    const items = (response.data?.skills ?? []).map((raw) =>
      skillHubItemSummary(parseSkillHubItem(raw)),
    );
    return { items, total: response.data?.total ?? 0, page, pageSize: limit };
  }

  async userSkills(
    signal: AbortSignal | undefined,
    handle: string,
    q: UserSkillsQuery,
  ): Promise<SearchPage> {
    const limit = boundedLimit(q.limit);
    const page = Math.max(1, q.page ?? 1);
    const path = "/api/v1/users/" + encodeURIComponent(handle) + "/skills";
    const response = await getJSON<{ count?: number; skills?: unknown[] }>(
      this.httpClient,
      endpoint(this.baseURL, path, {
        page: [String(page)],
        pageSize: [String(limit)],
      }),
      signal,
    );
    let items = (response.skills ?? []).map((raw) =>
      skillHubItemSummary(parseSkillHubItem(raw)),
    );
    if (q.query) items = filterSkills(items, q.query);
    return { items, total: response.count ?? 0, page, pageSize: limit };
  }

  async detail(
    signal: AbortSignal | undefined,
    id: SkillId,
  ): Promise<SkillDetail> {
    const response = await getJSON<{
      skill?: unknown;
      owner?: { handle?: string; displayName?: string };
      latestVersion?: unknown;
      securityReports?: unknown;
    }>(
      this.httpClient,
      endpoint(this.baseURL, "/api/v1/skills/" + encodeURIComponent(id.id)),
      signal,
    );
    const summary = skillHubItemSummary(parseSkillHubItem(response.skill));
    if (response.owner?.displayName) {
      summary.author = response.owner.displayName;
    } else if (response.owner?.handle) summary.author = response.owner.handle;
    const latest = parseVersion(response.latestVersion);
    if (latest !== "") summary.version = latest;
    return { ...summary, securityReports: response.securityReports ?? null };
  }

  async files(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<SkillFile[]> {
    const values: Record<string, string[]> = {};
    if (version) values.version = [version];
    const response = await getJSON<{ files?: unknown[] }>(
      this.httpClient,
      endpoint(
        this.baseURL,
        "/api/v1/skills/" + encodeURIComponent(id.id) + "/files",
        values,
      ),
      signal,
    );
    return (response.files ?? []).map(parseSkillFile);
  }

  evaluation(signal: AbortSignal | undefined, id: SkillId): Promise<unknown> {
    return getJSON<unknown>(
      this.httpClient,
      endpoint(
        this.baseURL,
        "/api/v1/skills/" + encodeURIComponent(id.id) + "/evaluation",
      ),
      signal,
    );
  }

  downloadSources(id: SkillId, version: string): DownloadSource[] {
    const values: Record<string, string[]> = { slug: [id.id] };
    if (version) values.version = [version];
    return [
      { url: endpoint(this.baseURL, "/api/v1/download", values), kind: "api" },
      {
        url:
          trimRight(this.downloadURL, "/") +
          "/skills/" +
          encodeURIComponent(id.id) +
          ".zip",
        kind: "cdn",
        fallback: true,
      },
    ];
  }

  async download(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<DownloadResult> {
    const values: Record<string, string[]> = { slug: [id.id] };
    if (version) values.version = [version];
    const primary = endpoint(this.baseURL, "/api/v1/download", values);
    try {
      const body = await downloadStream(this.httpClient, primary, signal);
      return { body, meta: { sourceUrl: primary } };
    } catch (error) {
      const fallback =
        trimRight(this.downloadURL, "/") +
        "/skills/" +
        encodeURIComponent(id.id) +
        ".zip";
      try {
        const body = await downloadStream(this.httpClient, fallback, signal);
        return { body, meta: { sourceUrl: fallback } };
      } catch (fallbackError) {
        throw new Error(
          `download ${id.id}: primary: ${(error as Error).message}; fallback: ${
            (fallbackError as Error).message
          }`,
        );
      }
    }
  }

  async showcase(
    signal: AbortSignal | undefined,
    kind: string,
    q: SearchQuery,
  ): Promise<SearchPage> {
    const response = await getJSON<{ items?: unknown[]; skills?: unknown[] }>(
      this.httpClient,
      endpoint(this.baseURL, "/api/v1/showcase/" + encodeURIComponent(kind), {
        limit: [String(boundedLimit(q.limit))],
      }),
      signal,
    );
    let rawItems = response.items ?? [];
    if (rawItems.length === 0) rawItems = response.skills ?? [];
    const items = rawItems.map((raw) =>
      skillHubItemSummary(parseSkillHubItem(raw)),
    );
    return {
      items,
      total: items.length,
      page: 1,
      pageSize: boundedLimit(q.limit),
    };
  }

  fileContent(): Promise<string> {
    return Promise.reject(
      new Error("SkillHub.cn does not expose skill file content"),
    );
  }

  async categories(signal: AbortSignal | undefined): Promise<Category[]> {
    const response = await getJSON<{ items?: unknown[] }>(
      this.httpClient,
      endpoint(this.baseURL, "/api/v1/categories"),
      signal,
    );
    return (response.items ?? []).map(parseCategory);
  }
}

/** Builds a SkillHub.cn client. */
export function createSkillHubClient(
  baseURL?: string,
  client?: HttpClient,
): SkillHubClient {
  return new SkillHubClient(baseURL, client);
}

export interface SkillHubItem {
  slug: string;
  name: string;
  displayName: string;
  description: string;
  summary: string;
  version: string;
  category: string;
  ownerName: string;
  ownerNameV1: string;
  homepage: string;
  iconUrl: string;
  iconUrlV1: string;
  sourceUrl: string;
  source: string;
  publisher?: {
    name: string;
    verified: boolean;
    certifiedName: string;
  };
  downloads: number;
  installs: number;
  stars: number;
  score: number;
  verified: boolean;
  tags: string[];
  stats: { downloads: number; installs: number; stars: number };
  updatedAtMs: number;
  updatedAtLegacy: number;
}

type Raw = Record<string, unknown>;

export function parseSkillHubItem(raw: unknown): SkillHubItem {
  const o = asRecord(raw);
  const stats = asRecord(o.stats);
  const publisher = asRecord(o.publisher);
  const hasPublisher = isObject(o.publisher);
  return {
    slug: str(o.slug),
    name: str(o.name),
    displayName: str(o.displayName),
    description: str(o.description),
    summary: str(o.summary),
    version: str(o.version),
    category: str(o.category),
    ownerName: str(o.ownerName),
    ownerNameV1: str(o.owner_name),
    homepage: str(o.homepage),
    iconUrl: str(o.iconUrl),
    iconUrlV1: str(o.icon_url),
    sourceUrl: str(o.sourceUrl),
    source: str(o.source),
    publisher: hasPublisher
      ? {
          name: str(publisher.name),
          verified: publisher.verified === true,
          certifiedName: str(publisher.certifiedName),
        }
      : undefined,
    downloads: num(o.downloads),
    installs: num(o.installs),
    stars: num(o.stars),
    score: num(o.score),
    verified: o.verified === true,
    tags: parseTags(o.tags),
    stats: {
      downloads: num(stats.downloads),
      installs: num(stats.installs),
      stars: num(stats.stars),
    },
    updatedAtMs: num(o.updatedAt),
    updatedAtLegacy: num(o.updated_at),
  };
}

export function skillHubItemSummary(s: SkillHubItem): SkillSummary {
  let description = s.description;
  if (description === "") description = s.summary;
  let name = s.name;
  if (name === "") name = s.displayName;
  let author = s.ownerName;
  if (author === "") author = s.ownerNameV1;
  let icon = s.iconUrl;
  if (icon === "") icon = s.iconUrlV1;
  let updated = s.updatedAtMs;
  if (updated === 0) updated = s.updatedAtLegacy;
  const updatedAt = updated > 0 ? new Date(updated) : undefined;
  let downloads = s.downloads;
  let installs = s.installs;
  let stars = s.stars;
  if (downloads === 0) downloads = s.stats.downloads;
  if (installs === 0) installs = s.stats.installs;
  if (stars === 0) stars = s.stats.stars;
  let publisherName = "";
  let certifiedName = "";
  let publisherVerified = false;
  if (s.publisher) {
    publisherName = s.publisher.name;
    certifiedName = s.publisher.certifiedName;
    publisherVerified = s.publisher.verified;
  }
  return {
    market: "skillhub.cn",
    id: s.slug,
    slug: s.slug,
    name,
    displayName: s.displayName,
    description,
    version: s.version,
    author,
    category: s.category,
    tags: s.tags.slice(),
    iconUrl: icon,
    homepage: s.homepage,
    sourceUrl: s.sourceUrl,
    source: s.source,
    publisherName,
    certifiedName,
    publisherVerified,
    downloads,
    installs,
    stars,
    score: s.score,
    verified: s.verified,
    updatedAt,
  };
}

function parseSkillFile(raw: unknown): SkillFile {
  const o = asRecord(raw);
  return {
    path: str(o.path),
    sha256: str(o.sha256) || undefined,
    size: num(o.size) || undefined,
  };
}

function parseCategory(raw: unknown): Category {
  const o = asRecord(raw);
  const children = Array.isArray(o.children)
    ? o.children.map(parseCategory)
    : [];
  return {
    key: str(o.key),
    name: str(o.name),
    nameEn: str(o.nameEn) || undefined,
    children: children.length > 0 ? children : undefined,
  };
}

function asRecord(value: unknown): Raw {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Raw;
  }
  return {};
}

function isObject(value: unknown): value is Raw {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value) || 0;
  return 0;
}

function trimRight(value: string, cut: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === cut) end--;
  return value.slice(0, end);
}
