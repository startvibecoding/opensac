// Ported from internal/skillhub/types.go
//
// Package skillhub provides marketplace clients and safe local installation
// for skills.

/** A supported skill marketplace identifier. */
export type Market = "skillhub.cn" | "clawhub.ai";

/** The built-in SkillHub.cn market id. */
export const MarketSkillHub: Market = "skillhub.cn";
/** The built-in ClawHub.ai market id. */
export const MarketClawHub: Market = "clawhub.ai";

export interface MarketCapabilities {
  search: boolean;
  list: boolean;
  cursorPagination: boolean;
  pagePagination: boolean;
  categories: boolean;
  showcase: boolean;
  authorFilter: boolean;
  userSkills: boolean;
  fileList: boolean;
  fileContent: boolean;
  evaluation: boolean;
}

export interface MarketInfo {
  id: Market;
  name: string;
  siteUrl: string;
  capabilities: MarketCapabilities;
}

export interface SearchQuery {
  query?: string;
  limit?: number;
  page?: number;
  cursor?: string;
  sort?: string;
  order?: string;
  category?: string;
  author?: string;
  verifiedOnly?: boolean;
  nonSuspiciousOnly?: boolean;
}

export interface UserSkillsQuery {
  query?: string;
  limit?: number;
  page?: number;
}

export interface SearchPage {
  items: SkillSummary[];
  total?: number;
  page?: number;
  pageSize?: number;
  nextCursor?: string;
}

export interface SkillId {
  market: Market;
  id: string;
}

export interface SkillSummary {
  market: Market;
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tags?: string[];
  iconUrl?: string;
  homepage?: string;
  sourceUrl?: string;
  source?: string;
  publisherName?: string;
  certifiedName?: string;
  publisherVerified?: boolean;
  downloads?: number;
  installs?: number;
  stars?: number;
  score?: number;
  verified?: boolean;
  suspicious?: boolean;
  updatedAt?: Date;
  installed?: InstalledState | null;
}

export interface SkillDetail extends SkillSummary {
  files?: SkillFile[];
  downloadSources?: DownloadSource[];
  readme?: string;
  securityReports?: unknown;
  evaluation?: unknown;
}

export interface DownloadSource {
  url: string;
  kind: string;
  fallback?: boolean;
}

export interface SkillFile {
  path: string;
  sha256?: string;
  size?: number;
}

export interface Category {
  key: string;
  name: string;
  nameEn?: string;
  children?: Category[];
}

export interface DownloadMeta {
  sourceUrl: string;
  filename?: string;
}

export interface InstalledState {
  installed: boolean;
  scope: string;
  dir: string;
  market?: Market;
  id?: string;
  name?: string;
  local?: boolean;
  version?: string;
  active?: boolean;
  updateAvailable?: boolean;
}

/** A downloaded archive stream plus its source metadata. */
export interface DownloadResult {
  body: ReadableStream<Uint8Array>;
  meta: DownloadMeta;
}

export interface MarketClient {
  market(): MarketInfo;
  search(
    signal: AbortSignal | undefined,
    query: SearchQuery,
  ): Promise<SearchPage>;
  userSkills(
    signal: AbortSignal | undefined,
    handle: string,
    query: UserSkillsQuery,
  ): Promise<SearchPage>;
  detail(signal: AbortSignal | undefined, id: SkillId): Promise<SkillDetail>;
  files(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<SkillFile[]>;
  evaluation(signal: AbortSignal | undefined, id: SkillId): Promise<unknown>;
  downloadSources(id: SkillId, version: string): DownloadSource[];
  download(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
  ): Promise<DownloadResult>;
  categories(signal: AbortSignal | undefined): Promise<Category[]>;
  /** Optional showcase capability (SkillHub.cn). */
  showcase?(
    signal: AbortSignal | undefined,
    kind: string,
    query: SearchQuery,
  ): Promise<SearchPage>;
  /** Optional raw file-content capability (ClawHub.ai). */
  fileContent?(
    signal: AbortSignal | undefined,
    id: SkillId,
    version: string,
    path: string,
  ): Promise<string>;
}
