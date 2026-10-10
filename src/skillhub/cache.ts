//
// Deno is single-threaded, so the Go sync.Mutex is dropped. Entries are cloned
// on read/write to preserve the Go value-copy semantics.

import {
  type Category,
  type SearchPage,
  type SkillDetail,
  type SkillSummary} from "./types.ts";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache {
  private readonly ttl: number;
  private pages = new Map<string, CacheEntry<SearchPage>>();
  private details = new Map<string, CacheEntry<SkillDetail>>();
  private categories = new Map<string, CacheEntry<Category[]>>();

  constructor(ttlMs: number) {
    this.ttl = ttlMs;
  }

  getPage(key: string): SearchPage | undefined {
    const entry = this.pages.get(key);
    if (!entry || !(Date.now() < entry.expiresAt)) return undefined;
    return cloneSearchPage(entry.value);
  }

  setPage(key: string, value: SearchPage): void {
    this.pages.set(key, {
      value: cloneSearchPage(value),
      expiresAt: Date.now() + this.ttl,
    });
  }

  getDetail(key: string): SkillDetail | undefined {
    const entry = this.details.get(key);
    if (!entry || !(Date.now() < entry.expiresAt)) return undefined;
    return cloneSkillDetail(entry.value);
  }

  setDetail(key: string, value: SkillDetail): void {
    this.details.set(key, {
      value: cloneSkillDetail(value),
      expiresAt: Date.now() + this.ttl,
    });
  }

  getCategories(key: string): Category[] | undefined {
    const entry = this.categories.get(key);
    if (!entry || !(Date.now() < entry.expiresAt)) return undefined;
    return cloneCategories(entry.value);
  }

  setCategories(key: string, value: Category[]): void {
    this.categories.set(key, {
      value: cloneCategories(value),
      expiresAt: Date.now() + this.ttl,
    });
  }

  clear(): void {
    this.pages = new Map();
    this.details = new Map();
    this.categories = new Map();
  }
}

/** Builds a fresh cache with the given TTL, mirroring createMemoryCache. */
export function createMemoryCache(ttlMs: number): MemoryCache {
  return new MemoryCache(ttlMs);
}

export function cloneSearchPage(page: SearchPage): SearchPage {
  const items = page.items.map(cloneSummary);
  return { ...page, items };
}

function cloneSummary(item: SkillSummary): SkillSummary {
  return {
    ...item,
    tags: item.tags ? item.tags.slice() : undefined,
    installed: item.installed ? { ...item.installed } : item.installed,
  };
}

export function cloneCategories(values: Category[]): Category[] {
  return values.map((value) => ({
    ...value,
    children: value.children ? cloneCategories(value.children) : undefined,
  }));
}

export function cloneSkillDetail(detail: SkillDetail): SkillDetail {
  const summary = cloneSummary(detail);
  return {
    ...summary,
    files: detail.files ? detail.files.map((f) => ({ ...f })) : undefined,
    downloadSources: detail.downloadSources
      ? detail.downloadSources.map((s) => ({ ...s }))
      : undefined,
  };
}
