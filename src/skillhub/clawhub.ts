import {
  boundedLimit,
  download as downloadStream,
  endpoint,
} from "./client_helpers.ts";
import {
  createHTTPClient,
  decodeJSON,
  getWithStatus,
  type HttpClient,
} from "./http.ts";
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

export const clawHubDefaultURL = "https://clawhub.ai";

// maxClawJSONBytes caps successful JSON response bodies (detail, files, search).
export const maxClawJSONBytes = 16 << 20;

// maxClawContentBytes caps raw file content responses, matching the previous
// fallback reader limit for FileContent.
export const maxClawContentBytes = 1 << 20;

// ambiguousSkillSlugCode is the ClawHub API code returned with HTTP 409 when a
// bare slug matches multiple skills and the caller must disambiguate.
export const ambiguousSkillSlugCode = "AMBIGUOUS_SKILL_SLUG";

export class ClawHubClient implements MarketClient {
  private readonly baseURL: string;
  private readonly httpClient: HttpClient;
  private readonly owners = new Map<string, string>();

  constructor(baseURL?: string, client?: HttpClient) {
    this.baseURL = trimRight(baseURL || clawHubDefaultURL, "/");
    this.httpClient = createHTTPClient(client);
  }

  market(): MarketInfo {
    return {
      id: "clawhub.ai",
      name: "ClawHub.ai",
      siteUrl: "https://clawhub.ai",
      capabilities: {
        search: true,
        list: true,
        cursorPagination: true,
        pagePagination: false,
        categories: false,
        showcase: false,
        authorFilter: true,
        userSkills: false,
        fileList: true,
        fileContent: true,
        evaluation: false,
      },
    };
  }

  async search(
    signal: AbortSignal | undefined,
    q: SearchQuery,
  ): Promise<SearchPage> {
    if ((q.query ?? "").trim() !== "") {
      const response = (await this.fetchJSON(
        signal,
        "/api/v1/search",
        { q: [q.query ?? ""], limit: [String(boundedLimit(q.limit))] },
        q.query ?? "",
      )) as { results?: unknown[] };
      const items = (response.results ?? []).map((raw) =>
        summaryOf(parseClawHubSearchItem(raw)),
      );
      return {
        items,
        total: items.length,
        page: 1,
        pageSize: boundedLimit(q.limit),
      };
    }
    const values: Record<string, string[]> = {
      limit: [String(boundedLimit(q.limit))],
    };
    if (q.cursor) values.cursor = [q.cursor];
    if (q.sort) values.order = [q.sort];
    if (q.author) values.author = [q.author];
    if (q.verifiedOnly) values.verifiedOnly = ["true"];
    if (q.nonSuspiciousOnly) values.nonSuspiciousOnly = ["true"];
    const response = (await this.fetchJSON(
      signal,
      "/api/v1/skills",
      values,
      q.author ?? "",
    )) as { items?: unknown[]; nextCursor?: string };
    const items = (response.items ?? []).map((raw) =>
      clawHubItemSummary(parseClawHubItem(raw)),
    );
    return {
      items,
      nextCursor: response.nextCursor ?? "",
      pageSize: boundedLimit(q.limit),
    };
  }

  // UserSkills is not available from the public ClawHub API. Search supports
  // author filtering.
  userSkills(
    signal: AbortSignal | undefined,
    handle: string,
    q: UserSkillsQuery,
  ): Promise<SearchPage> {
    return this.search(signal, {
      query: q.query,
      limit: q.limit,
      author: handle,
    });
  }

  async detail(
    signal: AbortSignal | undefined,
    id: SkillId,
  ): Promise<SkillDetail> {
    const { slug, owner: explicit } = clawSkillRef(id.id);
    const owner = explicit || this.ownerFor(slug);
    const values: Record<string, string[]> = {};
    if (owner) values.owner = [owner];
    const raw = await this.fetchJSON(
      signal,
      "/api/v1/skills/" + skillPath(slug),
      values,
      slug,
    );
    return parseClawHubDetail(raw, id.id);
  }

  async files(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<SkillFile[]> {
    const { slug, owner: explicit } = clawSkillRef(id.id);
    const owner = explicit || this.ownerFor(slug);
    const values: Record<string, string[]> = {};
    if (version) values.version = [version];
    if (owner) values.owner = [owner];
    const response = (await this.fetchJSON(
      signal,
      "/api/v1/skills/" + skillPath(slug) + "/files",
      values,
      slug,
    )) as { files?: unknown[]; items?: unknown[] };
    const files = (response.files ?? []).map(parseSkillFile);
    if (files.length > 0) return files;
    return (response.items ?? []).map(parseSkillFile);
  }

  evaluation(): Promise<unknown> {
    return Promise.resolve(null);
  }

  async fileContent(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
    filePath: string,
  ): Promise<string> {
    const { slug, owner: explicit } = clawSkillRef(id.id);
    const owner = explicit || this.ownerFor(slug);
    const values: Record<string, string[]> = {};
    if (version) values.version = [version];
    if (owner) values.owner = [owner];
    const path =
      "/api/v1/skills/" + skillPath(slug) + "/files/" + skillPath(filePath);
    try {
      const response = (await this.fetchJSON(signal, path, values, slug)) as {
        content?: string;
      };
      if (response.content) return response.content;
    } catch {
      // fall through to the raw reader
    }
    const body = await this.rawGet(
      signal,
      path,
      values,
      slug,
      maxClawContentBytes,
    );
    return new TextDecoder().decode(body);
  }

  downloadSources(id: SkillId, version: string): DownloadSource[] {
    const { slug, owner: explicit } = clawSkillRef(id.id);
    const owner = explicit || this.ownerFor(slug);
    const values: Record<string, string[]> = {};
    if (version) values.version = [version];
    if (owner) values.owner = [owner];
    return [
      {
        url: endpoint(
          this.baseURL,
          "/api/v1/skills/" + skillPath(slug) + "/download",
          values,
        ),
        kind: "api",
      },
    ];
  }

  async download(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<DownloadResult> {
    const { slug, owner: explicit } = clawSkillRef(id.id);
    const owner = explicit || this.ownerFor(slug);
    const values: Record<string, string[]> = {};
    if (version) values.version = [version];
    if (owner) values.owner = [owner];
    let path = endpoint(
      this.baseURL,
      "/api/v1/skills/" + skillPath(slug) + "/download",
      values,
    );
    try {
      const body = await downloadStream(this.httpClient, path, signal);
      return { body, meta: { sourceUrl: path } };
    } catch (error) {
      if (owner) throw error;
      const resolved = await this.resolveSlug(signal, slug);
      if (resolved === "") throw error;
      values.owner = [resolved];
      path = endpoint(
        this.baseURL,
        "/api/v1/skills/" + skillPath(slug) + "/download",
        values,
      );
      const body = await downloadStream(this.httpClient, path, signal);
      return { body, meta: { sourceUrl: path } };
    }
  }

  categories(): Promise<Category[]> {
    return Promise.resolve([]);
  }

  // fetchJSON fetches a JSON endpoint, transparently resolving 409
  // AMBIGUOUS_SKILL_SLUG responses for bare slugs: the request is retried once
  // with the owner of the unique exact-slug match.
  private async fetchJSON(
    signal: AbortSignal | undefined,
    path: string,
    values: Record<string, string[]>,
    originalSlug: string,
  ): Promise<unknown> {
    let url = endpoint(this.baseURL, path, values);
    let response = await getWithStatus(
      this.httpClient,
      url,
      maxClawJSONBytes,
      signal,
    );
    if (!response.error) return decodeJSON(url, response.body);
    if ((values.owner?.length ?? 0) > 0) throw response.error;
    const resolved = this.resolveAmbiguity(
      response.status,
      response.body,
      originalSlug,
    );
    if (!resolved.resolved) throw response.error;
    values.owner = [resolved.owner];
    url = endpoint(this.baseURL, path, values);
    response = await getWithStatus(
      this.httpClient,
      url,
      maxClawJSONBytes,
      signal,
    );
    if (response.error) throw response.error;
    return decodeJSON(url, response.body);
  }

  // rawGet fetches raw bytes (e.g. file content), resolving ambiguous bare
  // slugs the same way as fetchJSON.
  private async rawGet(
    signal: AbortSignal | undefined,
    path: string,
    values: Record<string, string[]>,
    originalSlug: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    let url = endpoint(this.baseURL, path, values);
    let response = await getWithStatus(this.httpClient, url, maxBytes, signal);
    if (!response.error) return response.body;
    if ((values.owner?.length ?? 0) > 0) throw response.error;
    const resolved = this.resolveAmbiguity(
      response.status,
      response.body,
      originalSlug,
    );
    if (!resolved.resolved) throw response.error;
    values.owner = [resolved.owner];
    url = endpoint(this.baseURL, path, values);
    response = await getWithStatus(this.httpClient, url, maxBytes, signal);
    if (response.error) throw response.error;
    return response.body;
  }

  // resolveSlug probes whether a bare slug is ambiguous and returns the owner
  // handle of the unique exact-slug match, caching it.
  private async resolveSlug(
    signal: AbortSignal | undefined,
    slug: string,
  ): Promise<string> {
    const url = endpoint(this.baseURL, "/api/v1/skills/" + skillPath(slug));
    const response = await getWithStatus(
      this.httpClient,
      url,
      maxClawJSONBytes,
      signal,
    );
    if (!response.error) return "";
    const resolved = this.resolveAmbiguity(
      response.status,
      response.body,
      slug,
    );
    if (!resolved.resolved) return "";
    return resolved.owner;
  }

  // resolveAmbiguity parses a 409 AMBIGUOUS_SKILL_SLUG payload and returns the
  // owner of the single match whose slug equals the requested slug. When the
  // matches do not identify one candidate, a descriptive error listing every
  // available ref is thrown.
  private resolveAmbiguity(
    status: number,
    body: Uint8Array,
    originalSlug: string,
  ): { resolved: boolean; owner: string } {
    if (status !== 409) return { resolved: false, owner: "" };
    let ambiguity: ClawAmbiguityError;
    try {
      ambiguity = parseClawAmbiguity(body);
    } catch {
      return { resolved: false, owner: "" };
    }
    if (ambiguity.code !== ambiguousSkillSlugCode) {
      return { resolved: false, owner: "" };
    }
    const exact = ambiguity.matches.filter(
      (match) => match.slug === originalSlug && match.ownerHandle !== "",
    );
    if (exact.length === 1) {
      this.cacheOwner(originalSlug, exact[0].ownerHandle);
      return { resolved: true, owner: exact[0].ownerHandle };
    }
    const refs: string[] = [];
    for (const match of ambiguity.matches) {
      let ref = match.ref;
      if (ref === "" && match.ownerHandle !== "") {
        ref = "@" + stripPrefix(match.ownerHandle, "@") + "/" + match.slug;
      }
      if (ref !== "") refs.push(ref);
    }
    if (refs.length === 0) refs.push(originalSlug);
    throw new Error(
      `skill ${JSON.stringify(
        originalSlug,
      )} on clawhub.ai is ambiguous; specify which one to install: ${refs.join(
        ", ",
      )}`,
    );
  }

  private ownerFor(slug: string): string {
    return this.owners.get(slug) ?? "";
  }

  private cacheOwner(slug: string, owner: string): void {
    this.owners.set(slug, owner);
  }
}

/** Builds a ClawHub client. */
export function createClawHubClient(
  baseURL?: string,
  client?: HttpClient,
): ClawHubClient {
  return new ClawHubClient(baseURL, client);
}

export function skillPath(id: string): string {
  return id
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function clawSkillRef(id: string): { slug: string; owner: string } {
  if (!id.startsWith("@")) return { slug: id, owner: "" };
  const rest = stripPrefix(id, "@");
  const idx = rest.indexOf("/");
  if (idx < 0) return { slug: id, owner: "" };
  const owner = rest.slice(0, idx);
  const slug = rest.slice(idx + 1);
  if (owner === "" || slug === "") return { slug: id, owner: "" };
  return { slug, owner };
}

// --- raw JSON models and parsers ---

export interface ClawHubItem {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  summary: string;
  version: string;
  latestVersion: string;
  author: string;
  owner: string;
  category: string;
  tags: string[];
  topics: string[];
  stats: { downloads: number; installs: number; stars: number };
  iconUrl: string;
  homepage: string;
  sourceUrl: string;
  downloads: number;
  installs: number;
  stars: number;
  score: number;
  verified: boolean;
  suspicious: boolean;
  updatedAt?: Date;
  updatedAtMs: number;
}

type Raw = Record<string, unknown>;

export function parseClawHubItem(raw: unknown): ClawHubItem {
  const o = asRecord(raw);
  const stats = asRecord(o.stats);
  return {
    id: str(o.id),
    slug: str(o.slug),
    name: str(o.name),
    displayName: str(o.displayName),
    description: str(o.description),
    summary: str(o.summary),
    version: str(o.version),
    latestVersion: parseVersion(o.latestVersion),
    author: str(o.author),
    owner: str(o.owner),
    category: str(o.category),
    tags: parseTags(o.tags),
    topics: Array.isArray(o.topics) ? o.topics.filter(isString) : [],
    stats: {
      downloads: num(stats.downloads),
      installs: num(stats.installs),
      stars: num(stats.stars),
    },
    iconUrl: str(o.iconUrl),
    homepage: str(o.homepage),
    sourceUrl: str(o.sourceUrl),
    downloads: num(o.downloads),
    installs: num(o.installs),
    stars: num(o.stars),
    score: num(o.score),
    verified: bool(o.verified),
    suspicious: bool(o.suspicious),
    updatedAt: parseTimestamp(o.updatedAt),
    updatedAtMs: num(o.updatedAtMs),
  };
}

export function clawHubItemSummary(s: ClawHubItem): SkillSummary {
  const id = s.id || s.slug;
  const slug = s.slug || id;
  const name = s.name || s.displayName;
  const description = s.summary || s.description;
  const author = s.author || s.owner;
  const version = s.version || s.latestVersion;
  const updated = s.updatedAtMs > 0 ? new Date(s.updatedAtMs) : s.updatedAt;
  let downloads = s.downloads;
  let installs = s.installs;
  let stars = s.stars;
  if (downloads === 0) downloads = s.stats.downloads;
  if (installs === 0) installs = s.stats.installs;
  if (stars === 0) stars = s.stats.stars;
  const tags = [...s.topics, ...s.tags];
  return {
    market: "clawhub.ai",
    id,
    slug,
    name,
    displayName: s.displayName,
    description,
    version,
    author,
    category: s.category,
    tags,
    iconUrl: s.iconUrl,
    homepage: s.homepage,
    sourceUrl: s.sourceUrl,
    downloads,
    installs,
    stars,
    score: s.score,
    verified: s.verified,
    suspicious: s.suspicious,
    updatedAt: updated,
  };
}

export interface ClawHubSearchItem {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  score: number;
  updatedAt?: Date;
  ownerHandle: string;
  owner: { handle: string; displayName: string };
}

export function parseClawHubSearchItem(raw: unknown): ClawHubSearchItem {
  const o = asRecord(raw);
  const owner = asRecord(o.owner);
  return {
    slug: str(o.slug),
    displayName: str(o.displayName),
    summary: str(o.summary),
    version: str(o.version),
    downloads: num(o.downloads),
    score: num(o.score),
    updatedAt: parseTimestamp(o.updatedAt),
    ownerHandle: str(o.ownerHandle),
    owner: {
      handle: str(owner.handle),
      displayName: str(owner.displayName),
    },
  };
}

// summaryOf builds a summary from a ClawHub search item.
function summaryOf(s: ClawHubSearchItem): SkillSummary {
  let owner = s.ownerHandle;
  if (owner === "") owner = s.owner.handle;
  let id = s.slug;
  if (owner !== "") id = "@" + stripPrefix(owner, "@") + "/" + s.slug;
  let author = s.owner.displayName;
  if (author === "") author = owner;
  return {
    market: "clawhub.ai",
    id,
    slug: s.slug,
    name: s.displayName,
    displayName: s.displayName,
    description: s.summary,
    version: s.version,
    author,
    category: "",
    downloads: s.downloads,
    score: s.score,
    updatedAt: s.updatedAt,
  };
}

export function parseClawHubDetail(raw: unknown, id: string): SkillDetail {
  const o = asRecord(raw);
  const skillRaw = o.skill;
  const itemRaw = o.item;
  const owner = asRecord(o.owner);
  const securityReports = o.securityReports ?? o.moderation ?? null;
  const evaluation = o.evaluation ?? null;
  const latestVersion = parseVersion(o.latestVersion);
  let item: ClawHubItem;
  if (isObject(skillRaw)) {
    item = parseClawHubItem(skillRaw);
  } else if (isObject(itemRaw)) {
    item = parseClawHubItem(itemRaw);
  } else {
    item = parseClawHubItem(raw);
  }
  if (item.id === "" && item.slug === "" && isObject(itemRaw)) {
    item = parseClawHubItem(itemRaw);
  }
  if (latestVersion !== "") item.latestVersion = latestVersion;
  if (item.author === "") {
    if (str(owner.displayName) !== "") item.author = str(owner.displayName);
    else item.author = str(owner.handle);
  }
  const summary = clawHubItemSummary(item);
  summary.id = id;
  return {
    ...summary,
    securityReports,
    evaluation,
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

export interface ClawAmbiguityError {
  code: string;
  message: string;
  slug: string;
  matches: {
    ownerHandle: string;
    slug: string;
    ref: string;
    url: string;
  }[];
}

export function parseClawAmbiguity(body: Uint8Array): ClawAmbiguityError {
  const raw = JSON.parse(new TextDecoder().decode(body)) as Raw;
  const matches = Array.isArray(raw.matches) ? raw.matches : [];
  return {
    code: str(raw.code),
    message: str(raw.message),
    slug: str(raw.slug),
    matches: matches.map((m) => {
      const r = asRecord(m);
      return {
        ownerHandle: str(r.ownerHandle),
        slug: str(r.slug),
        ref: str(r.ref),
        url: str(r.url),
      };
    }),
  };
}

// --- small JSON helpers ---

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

function bool(value: unknown): boolean {
  return value === true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function trimRight(value: string, cut: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === cut) end--;
  return value.slice(0, end);
}

/** Parses a version that may be a plain string or a `{version}` object. */
export function parseVersion(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isObject(raw)) {
    const v = str(raw.version);
    if (v !== "") return v;
  }
  return "";
}

/** Parses either an RFC3339 string or an epoch-seconds/millis number. */
export function parseTimestamp(raw: unknown): Date | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value === "" || value === "null") return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`parse timestamp ${JSON.stringify(value)}`);
    }
    return parsed;
  }
  if (typeof raw === "number") {
    return raw > 1e12 ? new Date(raw) : new Date(raw * 1000);
  }
  return undefined;
}

/** Parses a tag list or object map into sorted `key`/`key=value` strings. */
export function parseTags(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter(isString);
  if (isObject(raw)) {
    const keys = Object.keys(raw).sort();
    return keys.map((key) => {
      const value = raw[key];
      if (typeof value === "string" && value !== "") return `${key}=${value}`;
      return key;
    });
  }
  return [];
}
