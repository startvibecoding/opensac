// Shared test helpers for src/skillhub (mirrors the Go _test.go fixtures).

import type { HttpClient } from "./http.ts";
import type {
  Category,
  DownloadResult,
  DownloadSource,
  MarketClient,
  MarketInfo,
  SearchPage,
  SearchQuery,
  SkillDetail,
  SkillFile,
  SkillId,
  SkillSummary,
} from "./types.ts";
import { createZip, type ZipWriteEntry } from "./zip.ts";

/** Builds a JSON Response for the fake HTTP client. */
export function jsonResponse(
  body: string,
  status = 200,
  statusText = status === 200 ? "OK" : "",
): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/** Builds an HttpClient from a URL-path switch, mirroring roundTripFunc. */
export function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): HttpClient {
  return (url, init) => Promise.resolve(handler(url, init));
}

/** Builds a fixture ZIP archive from a name→content map. */
export function makeArchive(
  files: Record<string, string>,
  options: { store?: boolean } = {},
): Promise<Uint8Array> {
  const entries: ZipWriteEntry[] = Object.entries(files).map(
    ([name, content]) => ({ name, content }),
  );
  return createZip(entries, options);
}

/** Builds a readable stream over a fixed byte buffer. */
export function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function emptySummary(
  overrides: Partial<SkillSummary> = {},
): SkillSummary {
  return {
    market: "skillhub.cn",
    id: "",
    slug: "",
    name: "",
    displayName: "",
    description: "",
    version: "",
    author: "",
    category: "",
    ...overrides,
  };
}

export function emptyDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return { ...emptySummary(), ...overrides };
}

/** A configurable fake MarketClient, mirroring the Go fakeClient. */
export class FakeMarketClient implements MarketClient {
  detailValue: SkillDetail = emptyDetail();
  archive: Uint8Array = new Uint8Array(0);
  users: Record<string, SkillSummary[]> = {};
  fileList = false;
  fileEntries: SkillFile[] = [];
  evaluationCap = false;
  evaluationValue: unknown = null;

  market(): MarketInfo {
    return {
      id: "skillhub.cn",
      name: "SkillHub.cn",
      siteUrl: "",
      capabilities: {
        search: true,
        list: true,
        cursorPagination: false,
        pagePagination: true,
        categories: true,
        showcase: true,
        authorFilter: false,
        userSkills: true,
        fileList: this.fileList,
        fileContent: false,
        evaluation: this.evaluationCap,
      },
    };
  }

  search(): Promise<SearchPage> {
    return Promise.resolve({ items: [] });
  }

  userSkills(
    _signal: AbortSignal | undefined,
    handle: string,
  ): Promise<SearchPage> {
    const items = this.users[handle] ?? [];
    return Promise.resolve({ items, total: items.length });
  }

  detail(): Promise<SkillDetail> {
    return Promise.resolve(this.detailValue);
  }

  files(): Promise<SkillFile[]> {
    return Promise.resolve(this.fileEntries);
  }

  evaluation(): Promise<unknown> {
    return Promise.resolve(this.evaluationValue);
  }

  downloadSources(): DownloadSource[] {
    return [{ url: "https://example.test/skill.zip", kind: "test" }];
  }

  download(): Promise<DownloadResult> {
    return Promise.resolve({
      body: streamFrom(this.archive),
      meta: { sourceUrl: "https://example.test/skill.zip" },
    });
  }

  categories(): Promise<Category[]> {
    return Promise.resolve([]);
  }
}

/** A fake market client that counts Search calls (mirrors countingClient). */
export class CountingClient implements MarketClient {
  searches = 0;

  market(): MarketInfo {
    return {
      id: "skillhub.cn",
      name: "SkillHub.cn",
      siteUrl: "",
      capabilities: {
        search: true,
        list: false,
        cursorPagination: false,
        pagePagination: false,
        categories: false,
        showcase: false,
        authorFilter: false,
        userSkills: false,
        fileList: false,
        fileContent: false,
        evaluation: false,
      },
    };
  }

  search(
    _signal: AbortSignal | undefined,
    _query: SearchQuery,
  ): Promise<SearchPage> {
    this.searches++;
    return Promise.resolve({ items: [] });
  }

  userSkills(): Promise<SearchPage> {
    return Promise.resolve({ items: [] });
  }

  detail(): Promise<SkillDetail> {
    return Promise.resolve(emptyDetail());
  }

  files(): Promise<SkillFile[]> {
    return Promise.resolve([]);
  }

  evaluation(): Promise<unknown> {
    return Promise.resolve(null);
  }

  downloadSources(): DownloadSource[] {
    return [];
  }

  download(): Promise<DownloadResult> {
    return Promise.reject(new Error("not implemented"));
  }

  categories(): Promise<Category[]> {
    return Promise.resolve([]);
  }
}

/** A localhost HTTP server helper (mirrors httptest.NewServer). */
export async function startServer(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  let resolveAddr: (addr: Deno.NetAddr) => void = () => {};
  const addrPromise = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddr = resolve;
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: (addr) => resolveAddr(addr as Deno.NetAddr),
  }, handler);
  const addr = await addrPromise;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.shutdown(),
  };
}

/** Narrowed SkillId helper for tests. */
export function skillId(
  market: "skillhub.cn" | "clawhub.ai",
  id: string,
): SkillId {
  return { market, id };
}
