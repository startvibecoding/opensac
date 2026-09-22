// Ported from internal/serve/skillhub.go and internal/serve/skillhub_extra.go
//
// The SkillHub marketplace HTTP surface under /api/skillhub/. The Go
// `*channelRuntime` receiver maps to free functions over the standard
// Request/Response types; the run.go slice registers them on the route table.
//
// Deviations: `context.Context` maps to the Request's AbortSignal; `r.Body`
// decode with `json.Decoder.DisallowUnknownFields` maps to a bounded
// `Request.json` parse plus an explicit top-level unknown-field check (Go's
// non-object decode error text is approximated); `url.Values` maps to
// `URLSearchParams`; `url.PathUnescape` maps to `decodeURIComponent` (both
// leave `+` untouched); `filepath.Base` maps to @std/path `basename`.

import { basename } from "@std/path";
import {
  clientsForSettings,
  type InstallRequest,
  type InstallResult,
  type Market,
  MarketSkillHub,
  newLocalIndex,
  type SearchPage,
  type SearchQuery,
  type Service,
  Service as SkillHubService,
  type UserSkillsQuery,
} from "../skillhub/mod.ts";
import { projectSkillDirs } from "../skills/mod.ts";
import type { Server } from "./openaiapi/server.ts";
import {
  inspectSkillHubSession,
  refreshSkillHubSession,
  refreshSkillHubSessionMany,
  resolveSkillHubWorkDir,
  setActiveSkillsForSession,
  type SkillHubRuntime,
  skillHubRuntime,
  type SkillHubSessionState,
} from "./openaiapi/skillhub_session.ts";
import { writeJson } from "./http.ts";

/** skillHubInstallRequest ports the Go struct of the same name. */
export interface SkillHubInstallRequest {
  market: Market | string;
  id: string;
  version?: string;
  scope?: string;
  targetDir?: string;
  workDir?: string;
  sessionId?: string;
  overwrite?: boolean;
  activate?: boolean;
}

/** skillHubTarget ports the Go struct of the same name. */
export interface SkillHubTarget {
  path: string;
  scope: string;
  label: string;
}

/** skillHubSkillSetRequest ports the Go struct of the same name. */
export interface SkillHubSkillSetRequest {
  skills: SkillHubInstallRequest[];
  scope?: string;
  targetDir?: string;
  workDir?: string;
  sessionId?: string;
  activate?: boolean;
}

/** skillHubUninstallRequest ports the Go struct of the same name. */
export interface SkillHubUninstallRequest {
  market: Market | string;
  id: string;
  scope?: string;
  workDir?: string;
  sessionId?: string;
}

/** skillHubActivateRequest ports the Go struct of the same name. */
export interface SkillHubActivateRequest {
  name: string;
  workDir?: string;
  sessionId?: string;
}

/** skillHubActiveSkillsRequest ports the Go struct of the same name. */
export interface SkillHubActiveSkillsRequest {
  names: string[];
  workDir?: string;
  sessionId?: string;
}

export async function handleSkillHub(
  server: Server | null,
  request: Request,
): Promise<Response> {
  if (server === null) {
    return writeJson(() => {}, 503, { error: "API server not ready" });
  }
  try {
    return await routeSkillHub(server, request);
  } catch (err) {
    return skillHubErrorResponse(err);
  }
}

async function routeSkillHub(
  server: Server,
  request: Request,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const path = pathname
    .replace(/^\/api\/skillhub\//, "")
    .replace(/^\/+|\/+$/g, "");
  const params = new URL(request.url).searchParams;
  if (path === "markets" && request.method === "GET") {
    const { service } = await skillHubServiceForRequest(
      server,
      params.get("sessionId") ?? "",
      params.get("workDir") ?? "",
    );
    return writeJson(() => {}, 200, { markets: service.markets() });
  }
  if (path === "categories" && request.method === "GET") {
    return await handleSkillHubCategories(server, request);
  }
  if (path === "official" && request.method === "GET") {
    return await handleSkillHubOfficial(server, request);
  }
  if (path === "search" && request.method === "GET") {
    return await handleSkillHubSearch(server, request);
  }
  if (path.startsWith("skills/") && request.method === "GET") {
    return await handleSkillHubDetail(
      server,
      request,
      path.slice("skills/".length),
    );
  }
  if (path === "targets" && request.method === "GET") {
    return await handleSkillHubTargets(server, request);
  }
  if (path === "installed" && request.method === "GET") {
    return await handleSkillHubInstalled(server, request);
  }
  if (path === "install" && request.method === "POST") {
    return await handleSkillHubInstall(server, request);
  }
  if (path === "activate" && request.method === "POST") {
    return await handleSkillHubActivate(server, request);
  }
  if (path === "set-active" && request.method === "POST") {
    return await handleSkillHubSetActive(server, request);
  }
  if (path === "skillset" && request.method === "POST") {
    return await handleSkillHubSkillSet(server, request);
  }
  if (path === "uninstall" && request.method === "POST") {
    return await handleSkillHubUninstall(server, request);
  }
  if (path.startsWith("showcase/") && request.method === "GET") {
    return await handleSkillHubShowcase(
      server,
      request,
      path.slice("showcase/".length),
    );
  }
  if (path.startsWith("content/") && request.method === "GET") {
    return await handleSkillHubContent(
      server,
      request,
      path.slice("content/".length),
    );
  }
  if (
    path === "targets" || path === "markets" || path === "categories" ||
    path === "official" || path === "search" || path === "installed" ||
    path === "install" || path === "activate" || path === "set-active" ||
    path === "skillset" || path === "uninstall" ||
    path.startsWith("skills/") || path.startsWith("showcase/") ||
    path.startsWith("content/")
  ) {
    return new Response(null, { status: 405 });
  }
  return writeJson(() => {}, 404, {
    error: "SkillHub endpoint not found",
  });
}

async function handleSkillHubCategories(
  server: Server,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const { service, runtime } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const market = skillHubMarket(
    params.get("market") ?? "",
    runtime.defaultMarket ?? "",
  );
  const categories = await service.categories(
    request.signal,
    market,
  );
  return writeJson(() => {}, 200, { categories });
}

async function handleSkillHubOfficial(
  server: Server,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const { service } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const market = skillHubMarketOrEmpty(
    params.get("market") ?? "",
    MarketSkillHub,
  );
  if (market !== MarketSkillHub) {
    throw new Error(
      "official recommendations are available on SkillHub.cn only",
    );
  }
  const limit = skillHubQueryInt(params, "limit", 20);
  const page = skillHubQueryInt(params, "page", 1);
  const query: UserSkillsQuery = {
    query: params.get("q") ?? "",
    limit,
    page,
  };
  const result = await service.official(request.signal, query);
  return writeJson(() => {}, 200, result);
}

async function handleSkillHubSearch(
  server: Server,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const { service, runtime } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const market = skillHubMarket(
    params.get("market") ?? "",
    runtime.defaultMarket ?? "",
  );
  const limit = skillHubQueryInt(params, "limit", 20);
  const page = skillHubQueryInt(params, "page", 1);
  const query: SearchQuery = {
    query: params.get("q") ?? "",
    limit,
    page,
    cursor: params.get("cursor") ?? "",
    sort: params.get("sort") ?? "",
    order: params.get("order") ?? "",
    category: params.get("category") ?? "",
  };
  const result = await service.search(request.signal, market, query);
  return writeJson(() => {}, 200, result);
}

async function handleSkillHubDetail(
  server: Server,
  request: Request,
  path: string,
): Promise<Response> {
  const filesOnly = path.endsWith("/files");
  if (filesOnly) path = path.slice(0, -"/files".length);
  const { market, id } = parseSkillHubPath(path);
  const params = new URL(request.url).searchParams;
  const { service } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const detail = await service.detail(request.signal, market, id);
  if (filesOnly) {
    return writeJson(() => {}, 200, { files: detail.files });
  }
  return writeJson(() => {}, 200, detail);
}

async function handleSkillHubTargets(
  server: Server,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const sessionID = (params.get("sessionId") ?? "").trim();
  if (sessionID === "") {
    throw new Error("sessionId is required");
  }
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    params.get("workDir") ?? "",
  );
  const runtime = skillHubRuntime(server);
  const labels = [
    "OpenSAC project skills",
    "Project skills",
    "Agents skills",
    "Generic project skills",
  ];
  const dirs = projectSkillDirs(workDir);
  const targets: SkillHubTarget[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const label = i < labels.length ? labels[i] : "Project skills";
    targets.push({ path: dirs[i], scope: "project", label });
  }
  if (runtime.globalSkillsDir) {
    targets.push({
      path: runtime.globalSkillsDir,
      scope: "global",
      label: "Global skills",
    });
  }
  return writeJson(() => {}, 200, {
    sessionId: sessionID,
    workDir,
    targets,
  });
}

async function handleSkillHubInstalled(
  server: Server,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const runtime = skillHubRuntime(server);
  const workDir = await resolveSkillHubWorkDir(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const index = newLocalIndex(
    runtime.globalSkillsDir ?? "",
    projectSkillDirs(workDir),
  );
  const response: Record<string, unknown> = {
    installed: index.list(),
    workDir,
  };
  const state = await inspectSkillHubSession(
    server,
    params.get("sessionId") ?? "",
    workDir,
  );
  response["session"] = state;
  return writeJson(() => {}, 200, response);
}

async function handleSkillHubInstall(
  server: Server,
  request: Request,
): Promise<Response> {
  const req = await decodeSkillHubJSON(request, [
    "market",
    "id",
    "version",
    "scope",
    "targetDir",
    "workDir",
    "sessionId",
    "overwrite",
    "activate",
  ]) as SkillHubInstallRequest;
  const runtime = skillHubRuntime(server);
  const market = skillHubMarket(
    String(req.market ?? ""),
    runtime.defaultMarket ?? "",
  );
  if ((req.sessionId ?? "").trim() === "") {
    throw new Error("sessionId is required for installation");
  }
  if ((req.id ?? "").trim() === "") {
    throw new Error("skill id is required");
  }
  if ((req.targetDir ?? "").trim() === "") {
    throw new Error("targetDir is required for installation");
  }
  let scope = req.scope ?? "";
  if (scope === "") {
    scope = runtime.defaultScope ?? "";
  }
  if (scope !== "project" && scope !== "global") {
    throw new Error("scope must be project or global");
  }
  const { service } = await skillHubServiceForRequest(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
  );
  const installRequest: InstallRequest = {
    market,
    id: req.id,
    version: req.version,
    scope,
    targetDir: req.targetDir ?? "",
    overwrite: req.overwrite,
  };
  const result = await service.install(request.signal, installRequest);
  let state: SkillHubSessionState;
  try {
    state = await refreshSkillHubSession(
      server,
      req.sessionId ?? "",
      req.workDir ?? "",
      activationName(req.activate ?? false, result.name),
    );
  } catch (err) {
    throw new Error(
      `installed, but failed to refresh session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return writeJson(() => {}, 200, {
    install: result,
    activated: req.activate,
    session: state,
  });
}

async function handleSkillHubActivate(
  server: Server,
  request: Request,
): Promise<Response> {
  const req = await decodeSkillHubJSON(request, [
    "name",
    "workDir",
    "sessionId",
  ]) as SkillHubActivateRequest;
  if ((req.name ?? "").trim() === "") {
    throw new Error("skill name is required");
  }
  const state = await refreshSkillHubSession(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
    req.name,
  );
  return writeJson(() => {}, 200, { activated: true, session: state });
}

async function handleSkillHubUninstall(
  server: Server,
  request: Request,
): Promise<Response> {
  const req = await decodeSkillHubJSON(request, [
    "market",
    "id",
    "scope",
    "workDir",
    "sessionId",
  ]) as SkillHubUninstallRequest;
  if (!req.market || (req.id ?? "").trim() === "") {
    throw new Error("market and skill id are required");
  }
  const { service } = await skillHubServiceForRequest(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
  );
  service.uninstall(req.market as Market, req.id, req.scope ?? "");
  const state = await refreshSkillHubSession(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
    "",
  );
  return writeJson(() => {}, 200, { uninstalled: true, session: state });
}

async function handleSkillHubSkillSet(
  server: Server,
  request: Request,
): Promise<Response> {
  const req = await decodeSkillHubJSON(request, [
    "skills",
    "scope",
    "targetDir",
    "workDir",
    "sessionId",
    "activate",
  ]) as SkillHubSkillSetRequest;
  if (!req.skills || req.skills.length === 0) {
    throw new Error("skillset must contain skills");
  }
  if (
    (req.sessionId ?? "").trim() === "" || (req.targetDir ?? "").trim() === ""
  ) {
    throw new Error("sessionId and targetDir are required for installation");
  }
  const { service, runtime } = await skillHubServiceForRequest(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
  );
  const installs: InstallRequest[] = [];
  for (const item of req.skills) {
    const market = skillHubMarket(
      String(item.market ?? ""),
      runtime.defaultMarket ?? "",
    );
    let scope = item.scope ?? "";
    if (scope === "") {
      scope = req.scope ?? "";
    }
    if (scope === "") {
      scope = runtime.defaultScope ?? "";
    }
    installs.push({
      market,
      id: item.id,
      version: item.version,
      scope,
      targetDir: req.targetDir ?? "",
      overwrite: item.overwrite,
    });
  }
  const results = await service.installSkillSet(request.signal, installs);
  const activeNames: string[] = [];
  if (req.activate) {
    for (const result of results) {
      activeNames.push(activationName(true, result.name));
    }
  }
  let state: SkillHubSessionState;
  if (req.activate) {
    state = await refreshSkillHubSessionMany(
      server,
      req.sessionId ?? "",
      req.workDir ?? "",
      activeNames,
    );
  } else {
    state = await refreshSkillHubSession(
      server,
      req.sessionId ?? "",
      req.workDir ?? "",
      "",
    );
  }
  return writeJson(() => {}, 200, { installs: results, session: state });
}

async function handleSkillHubShowcase(
  server: Server,
  request: Request,
  kind: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const { service, runtime } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const market = skillHubMarket(
    params.get("market") ?? "",
    runtime.defaultMarket ?? "",
  );
  const query: SearchQuery = { limit: 20 };
  const result = await service.showcase(request.signal, market, kind, query);
  return writeJson(() => {}, 200, result);
}

async function handleSkillHubContent(
  server: Server,
  request: Request,
  path: string,
): Promise<Response> {
  const { market, id } = parseSkillHubPath(path);
  const params = new URL(request.url).searchParams;
  const filePath = params.get("path") ?? "";
  if (filePath === "") {
    throw new Error("path is required");
  }
  const { service } = await skillHubServiceForRequest(
    server,
    params.get("sessionId") ?? "",
    params.get("workDir") ?? "",
  );
  const content = await service.fileContent(
    request.signal,
    market,
    id,
    params.get("version") ?? "",
    filePath,
  );
  return writeJson(() => {}, 200, { content });
}

async function handleSkillHubSetActive(
  server: Server,
  request: Request,
): Promise<Response> {
  const req = await decodeSkillHubJSON(request, [
    "names",
    "workDir",
    "sessionId",
  ]) as SkillHubActiveSkillsRequest;
  const state = await setActiveSkillsForSession(
    server,
    req.sessionId ?? "",
    req.workDir ?? "",
    req.names ?? [],
  );
  return writeJson(() => {}, 200, { session: state });
}

/** skillHubServiceForRequest ports the Go helper of the same name. */
export async function skillHubServiceForRequest(
  server: Server,
  sessionID: string,
  requestedWorkDir: string,
): Promise<{ service: Service; runtime: SkillHubRuntime }> {
  const runtime = skillHubRuntime(server);
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    requestedWorkDir,
  );
  const service = SkillHubService.forWorkDir(
    runtime.globalSkillsDir ?? "",
    workDir,
    runtime.officialHandles ?? [],
    ...clientsForSettings(server.settings?.skillHub ?? {}),
  );
  return { service, runtime };
}

/** parseSkillHubPath ports the Go helper of the same name. */
export function parseSkillHubPath(
  path: string,
): { market: Market; id: string } {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const idx = trimmed.indexOf("/");
  const parts = idx === -1
    ? [trimmed]
    : [trimmed.slice(0, idx), trimmed.slice(idx + 1)];
  if (parts.length !== 2 || parts[1] === "") {
    throw new Error("market and skill id are required");
  }
  const market = skillHubMarket(parts[0], "");
  let id: string;
  try {
    id = decodeURIComponent(parts[1]);
  } catch {
    throw new Error("invalid skill id");
  }
  if (id.trim() === "") {
    throw new Error("invalid skill id");
  }
  return { market, id };
}

/** skillHubMarket ports the Go helper of the same name. */
export function skillHubMarket(value: string, fallback: string): Market {
  if (value === "") {
    value = fallback;
  }
  const market = value as Market;
  if (market !== MarketSkillHub && market !== "clawhub.ai") {
    throw new Error(`unsupported marketplace ${JSON.stringify(value)}`);
  }
  return market;
}

/**
 * skillHubMarketOrEmpty collapses an invalid marketplace to "" the way Go's
 * two-value `(skillhub.Market, error)` return is consumed by the official
 * handler, which rewrites both the parse failure and the wrong-market case
 * into the same user-visible error.
 */
function skillHubMarketOrEmpty(value: string, fallback: string): Market {
  try {
    return skillHubMarket(value, fallback);
  } catch {
    return "" as Market;
  }
}

/** skillHubQueryInt ports the Go helper of the same name. */
export function skillHubQueryInt(
  values: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const value = values.get(key) ?? "";
  if (value === "") {
    return fallback;
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

const SKILL_HUB_BODY_LIMIT = 1 << 20; // 1 MiB, Go's io.LimitReader bound

/**
 * decodeSkillHubJSON ports the Go helper: a bounded, strict JSON decode.
 * Unknown fields are rejected the way `json.Decoder.DisallowUnknownFields`
 * does for these flat request structs; an over-large body surfaces as an
 * invalid-JSON error like Go's truncated `io.LimitReader` decode.
 */
export async function decodeSkillHubJSON(
  request: Request,
  knownFields: string[],
): Promise<unknown> {
  let parsed: unknown;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > SKILL_HUB_BODY_LIMIT) {
      throw new Error("unexpected EOF");
    }
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    throw new Error(
      `invalid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid JSON: expected a JSON object");
  }
  const allowed = new Set(knownFields);
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new Error(
        `invalid JSON: json: unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  return parsed;
}

/** writeSkillHubError ports the Go helper's status mapping. */
export function skillHubErrorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("not in allowedWorkDirs") ||
    message.includes("overrides are disabled")
  ) {
    return 403;
  }
  if (message.includes("not found")) {
    return 404;
  }
  if (message.includes("failed to refresh session")) {
    return 500;
  }
  return 400;
}

/**
 * skillHubErrorResponse is the adapter-level projection of Go's
 * `writeSkillHubError`: the route wrapper catches handler errors and maps
 * them to the same status/message pair.
 */
export function skillHubErrorResponse(err: unknown): Response {
  return writeJson(() => {}, skillHubErrorStatus(err), {
    error: err instanceof Error ? err.message : String(err),
  });
}

export function activationName(activate: boolean, name: string): string {
  if (activate) {
    return basename(name);
  }
  return "";
}

// Re-exported for the route table and tests.
export type { InstallResult, SearchPage };
