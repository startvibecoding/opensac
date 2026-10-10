// The /skillhub marketplace browser: one framed popup panel in the mothx
// dialog style (rounded wire frame, title, selectable list, footer hint).
//
// The panel is a DialogController over src/tui/dialog.ts, so it shares the
// exact render shape of the auth/settings/env dialogs: browse page (market and
// category tabs + skill list), detail page, and an install-scope picker. It
// owns cursor and pagination state only; every read and mutation goes through
// the shared SkillHub service surface, and results report back as panel status
// lines rather than transcript spam.

import {
  type Category,
  type InstallRequest,
  type InstallResult,
  type Market,
  type MarketInfo,
  type SearchPage,
  type SkillDetail,
  type SkillSummary,
  type UserSkillsQuery} from "../skillhub/mod.ts";
import { createLocalIndex } from "../skillhub/local.ts";
import { type DialogController, type DialogItem, type DialogPage } from "./dialog.ts";
import { type KeyEvent } from "./keys.ts";
import type { Translator } from "./i18n.ts";
import { ACCENT, BOLD, DIM, RESET } from "./theme.ts";

/** Remote page size for search/official browsing. */
export const PAGE_SIZE = 20;

/** The built-in official-recommendations pseudo-market tab id. */
const OFFICIAL_TAB = "official";

/** One installed-skill row for the Installed tab. */
export interface SkillHubInstalledEntry {
  dir: string;
  scope: string;
  version: string;
  market: string;
  id: string;
  name: string;
  local: boolean;
  updateAvailable: boolean;
}

/**
 * The session surface the panel may read and mutate. Mirrors the narrow
 * DialogHost style: async service calls plus render scheduling.
 */
export interface SkillHubPanelHost {
  readonly translator: Translator;
  /** Markets served by the shared SkillHub service. */
  markets(): Promise<MarketInfo[]>;
  search(
    market: Market,
    query: {
      query?: string;
      category?: string;
      limit?: number;
      page?: number;
      cursor?: string;
    },
  ): Promise<SearchPage>;
  official(query: UserSkillsQuery): Promise<SearchPage>;
  categories(market: Market): Promise<Category[]>;
  detail(market: Market, id: string): Promise<SkillDetail>;
  install(request: InstallRequest): Promise<InstallResult>;
  uninstall(market: Market, id: string, scope: string): Promise<void>;
  /** Installed marketplace skills under the configured skill dirs. */
  listInstalled(): SkillHubInstalledEntry[];
  /** Activates one freshly installed skill in the current session. */
  activateSkill(name: string): Promise<string>;
  /** Default install scope for the current work directory. */
  defaultScope(): "project" | "global";
  /** Target skills directory for one scope. */
  targetDir(scope: string): string;
  /** Reports a settled message to the transcript when the panel closes. */
  settle(message: string, error?: boolean): void;
  requestRender(): void;
}

type Tab = "browse" | "installed";
type View = "list" | "detail" | "scope";

/** Panel state machine. Owned by the session; keys route through handleKey. */
export class SkillHubPanel implements DialogController {
  #host: SkillHubPanelHost;
  #dialog: { close(msg?: string, err?: boolean): void };
  #tab: Tab = "browse";
  #view: View = "list";
  #cursor = 0;
  #loading = true;
  #error = "";
  #status = "";
  /** Current market and its category list (browse tab). */
  /** Selected market id; OFFICIAL_TAB is the recommendations tab. */
  #market: string = OFFICIAL_TAB;

  /** The active market as a typed id (never OFFICIAL_TAB). */
  get #activeMarket(): Market {
    return this.#market as Market;
  }
  #categories: Category[] = [];
  #categoryIndex = 0; // 0 = all
  #items: SkillSummary[] = [];
  #installed: SkillHubInstalledEntry[] = [];
  #query = "";
  /** True while typed text feeds the inline filter. */
  #filtering = false;
  #page = 1;
  #totalPages = 1;
  #nextCursor = "";
  #cursors: number[] = [0];
  #detail: SkillDetail | undefined;
  #detailLoading = false;
  /** Pending install: scope picker after Enter on a skill row. */
  #pendingInstall: SkillSummary | undefined;
  #scopeCursor = 0;
  #busy = false;
  #closed = false;

  constructor(
    host: SkillHubPanelHost,
    dialog: { close(msg?: string, err?: boolean): void },
  ) {
    this.#host = host;
    this.#dialog = dialog;
    void this.#init();
  }

  async #init(): Promise<void> {
    try {
      const markets = await this.#host.markets();
      if (this.#closed) return;
      this.#marketIds = markets.map((m) => m.id);
      this.#market = markets[0]?.id ?? this.#market;
    } catch {
      // Keep the default tab; the list load below reports real failures.
    }
    await this.#loadList();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Closes the panel; `message` (when set) settles to the transcript. */
  close(message = "", error = false): void {
    if (this.#closed) return;
    this.#closed = true;
    if (message !== "") this.#host.settle(message, error);
    this.#dialog.close();
  }

  // --- Data loading ---------------------------------------------------------

  async #loadList(): Promise<void> {
    if (this.#closed) return;
    this.#loading = true;
    this.#error = "";
    this.#host.requestRender();
    try {
      if (this.#closed) return;
      if (this.#tab === "installed") {
        this.#installed = this.#host.listInstalled();
        this.#items = [];
      } else if (this.#market === OFFICIAL_TAB) {
        const page = await this.#host.official({
          query: this.#query,
          limit: PAGE_SIZE,
          page: this.#page,
        });
        this.#applyPage(page);
      } else {
        const page = await this.#host.search(this.#activeMarket, {
          query: this.#query,
          category: this.#currentCategoryKey(),
          limit: PAGE_SIZE,
          page: this.#page,
        });
        this.#applyPage(page);
      }
    } catch (err) {
      if (this.#closed) return;
      this.#error = errorMessage(err);
      this.#items = [];
      this.#installed = [];
    }
    this.#loading = false;
    this.#clampCursor();
    this.#host.requestRender();
    // Categories are independent of the list; fetch once per market.
    if (
      this.#tab === "browse" && this.#market !== OFFICIAL_TAB &&
      this.#categories.length === 0 && this.#error === ""
    ) {
      void this.#loadCategories();
    }
  }

  async #loadCategories(): Promise<void> {
    try {
      const cats = await this.#host.categories(this.#activeMarket);
      if (this.#closed || this.#market === OFFICIAL_TAB) return;
      this.#categories = cats;
      this.#host.requestRender();
    } catch {
      // Categories are optional enrichment; failures leave the tab row empty.
    }
  }

  #applyPage(page: SearchPage): void {
    this.#items = page.items;
    const total = page.total ?? page.items.length;
    this.#totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
    this.#nextCursor = page.nextCursor ?? "";
  }

  async #openDetail(item: SkillSummary): Promise<void> {
    if (this.#closed) return;
    this.#view = "detail";
    this.#detail = undefined;
    this.#detailLoading = true;
    this.#error = "";
    this.#host.requestRender();
    try {
      const detail = await this.#host.detail(item.market, item.id);
      if (this.#closed || this.#view !== "detail") return;
      this.#detail = detail;
    } catch (err) {
      if (this.#closed) return;
      this.#error = errorMessage(err);
    }
    this.#detailLoading = false;
    this.#host.requestRender();
  }

  // --- Key routing ----------------------------------------------------------

  /** Applies one key event. Returns true when the panel consumed it. */
  handleKey(ev: KeyEvent): boolean {
    if (this.#closed) return false;

    if (this.#view === "scope") return this.#handleScopeKey(ev);

    if (ev.type === "text") {
      const t = ev.text.toLowerCase();
      if (this.#view === "list") {
        switch (t) {
          case "q":
            this.close();
            return true;
          case "/":
            // "/" starts (or restarts) the inline filter; typed text appends.
            this.#query = "";
            this.#filtering = true;
            this.#status = "";
            return true;
          case "r":
            void this.#loadList();
            return true;
          case "i":
            this.#tab = this.#tab === "installed" ? "browse" : "installed";
            this.#resetListState();
            void this.#loadList();
            return true;
          case "backspace":
            if (this.#query !== "") {
              this.#query = this.#query.slice(0, -1);
              this.#resetListState();
              void this.#loadList();
            }
            return true;
          default:
            if (this.#filtering) {
              this.#query += ev.text;
              this.#resetListState();
              void this.#loadList();
              return true;
            }
            return false;
        }
      }
      // Detail view: i installs, u uninstalls, esc/q backs out.
      switch (t) {
        case "i":
          if (this.#detail !== undefined && !this.#busy) {
            this.#beginInstall(this.#detail);
          }
          return true;
        case "u":
          if (this.#detail !== undefined) void this.#uninstallSelected();
          return true;
        case "q":
          this.#backToList();
          return true;
        default:
          return false;
      }
    }

    switch (ev.name) {
      case "escape":
        if (this.#view === "detail") this.#backToList();
        else this.close();
        return true;
      case "up":
        this.#move(-1);
        return true;
      case "down":
        this.#move(1);
        return true;
      case "left":
        this.#switchTab(-1);
        return true;
      case "right":
        this.#switchTab(1);
        return true;
      case "pageup":
        this.#switchPage(-1);
        return true;
      case "pagedown":
        this.#switchPage(1);
        return true;
      case "enter":
        if (this.#view === "list") {
          const item = this.#selectedItem();
          if (item !== undefined) void this.#openDetail(item);
        }
        return true;
      default:
        return false;
    }
  }

  #handleScopeKey(ev: KeyEvent): boolean {
    const scopes = this.#scopeOptions();
    if (ev.type === "text") {
      if (ev.text.toLowerCase() === "q") {
        this.#view = "detail";
        return true;
      }
      return false;
    }
    switch (ev.name) {
      case "escape":
        this.#view = "detail";
        return true;
      case "up":
        this.#scopeCursor = (this.#scopeCursor + scopes.length - 1) %
          Math.max(scopes.length, 1);
        this.#host.requestRender();
        return true;
      case "down":
        this.#scopeCursor = (this.#scopeCursor + 1) %
          Math.max(scopes.length, 1);
        this.#host.requestRender();
        return true;
      case "enter": {
        const scope = scopes[this.#scopeCursor];
        if (scope !== undefined) void this.#runInstall(scope.value);
        return true;
      }
      default:
        return false;
    }
  }

  #backToList(): void {
    this.#view = "list";
    this.#detail = undefined;
    this.#pendingInstall = undefined;
    this.#error = "";
  }

  #resetListState(): void {
    this.#cursor = 0;
    this.#cursors = [0];
    this.#page = 1;
    this.#totalPages = 1;
    this.#nextCursor = "";
    this.#items = [];
    this.#status = "";
  }

  #selectedItem(): SkillSummary | undefined {
    return this.#items[this.#cursor];
  }

  #move(delta: number): void {
    const total = this.#tab === "installed"
      ? this.#installed.length
      : this.#items.length;
    if (total === 0) return;
    this.#cursor += delta;
    if (this.#cursor < 0) this.#cursor = total - 1;
    if (this.#cursor >= total) this.#cursor = 0;
    this.#host.requestRender();
  }

  /** Left/right cycles markets + category tabs on the browse list. */
  #switchTab(delta: number): void {
    if (this.#tab !== "browse" || this.#view !== "list") return;
    const markets = this.#marketTabs();
    const mIdx = markets.indexOf(this.#market);
    const catCount = this.#categories.length;
    let next = mIdx + delta;
    // Treat categories as continuing slots after the market column.
    if (next >= markets.length + catCount + 1) next = 0;
    if (next < 0) next = markets.length + catCount;
    if (next < markets.length) {
      this.#market = markets[next] as Market;
      this.#categories = [];
      this.#categoryIndex = 0;
      this.#resetListState();
      void this.#loadList();
      return;
    }
    const slot = next - markets.length; // 0 = all, 1..n = categories
    this.#categoryIndex = Math.min(slot, catCount);
    this.#resetListState();
    void this.#loadList();
  }

  #marketTabs(): string[] {
    return [OFFICIAL_TAB, ...this.#marketIds];
  }

  /** Known market ids, refreshed when the market list loads. */
  #marketIds: string[] = [];

  #switchPage(delta: number): void {
    if (this.#tab !== "browse" || this.#view !== "list") return;
    if (delta > 0) {
      if (this.#nextCursor !== "") {
        this.#cursors.push(this.#cursor);
        void this.#loadNextCursor();
        return;
      }
      if (this.#page >= this.#totalPages) return;
      this.#page += 1;
    } else {
      if (this.#page <= 1) return;
      this.#page -= 1;
    }
    this.#cursor = 0;
    void this.#loadList();
  }

  async #loadNextCursor(): Promise<void> {
    if (this.#closed || this.#market === OFFICIAL_TAB) return;
    this.#loading = true;
    this.#host.requestRender();
    try {
      const page = await this.#host.search(this.#activeMarket, {
        query: this.#query,
        category: this.#currentCategoryKey(),
        limit: PAGE_SIZE,
        cursor: this.#nextCursor,
      });
      if (this.#closed) return;
      this.#applyPage(page);
      this.#page += 1;
      this.#cursor = 0;
    } catch (err) {
      if (!this.#closed) this.#error = errorMessage(err);
    }
    this.#loading = false;
    this.#host.requestRender();
  }

  #currentCategoryKey(): string | undefined {
    if (this.#categoryIndex === 0) return undefined;
    return this.#categories[this.#categoryIndex - 1]?.key;
  }

  // --- Install / uninstall ---------------------------------------------------

  #scopeOptions(): DialogItem[] {
    const tr = this.#host.translator;
    return [
      {
        label: tr.text("skillhub.panel.scope.project"),
        value: "project",
        description: this.#host.targetDir("project"),
      },
      {
        label: tr.text("skillhub.panel.scope.global"),
        value: "global",
        description: this.#host.targetDir("global"),
      },
    ];
  }

  #beginInstall(item: SkillSummary): void {
    this.#pendingInstall = item;
    this.#scopeCursor = this.#host.defaultScope() === "global" ? 1 : 0;
    this.#view = "scope";
    this.#status = "";
    this.#host.requestRender();
  }

  async #runInstall(scope: string): Promise<void> {
    const item = this.#pendingInstall;
    if (item === undefined || this.#busy) return;
    this.#busy = true;
    this.#status = this.#host.translator.text("skillhub.panel.installing");
    this.#host.requestRender();
    try {
      const result = await this.#host.install({
        market: item.market,
        id: item.id,
        scope,
        targetDir: this.#host.targetDir(scope),
        overwrite: true,
      });
      if (this.#closed) return;
      const activated = await this.#host.activateSkill(result.name);
      if (this.#closed) return;
      this.#status = this.#host.translator.text(
        "skillhub.panel.installed",
        result.name,
        scope,
      );
      if (activated !== "") {
        this.#status += `\n${activated}`;
      }
      // Refresh detail's installed badge.
      this.#detail = await this.#host.detail(item.market, item.id);
    } catch (err) {
      if (!this.#closed) this.#status = errorMessage(err);
    }
    this.#busy = false;
    this.#view = "detail";
    this.#pendingInstall = undefined;
    this.#host.requestRender();
  }

  async #uninstallSelected(): Promise<void> {
    const item = this.#detail ?? this.#selectedItem();
    if (item === undefined) return;
    const state = item.installed;
    if (state === null || state === undefined || !state.installed) {
      this.#status = this.#host.translator.text("skillhub.panel.not_installed");
      this.#host.requestRender();
      return;
    }
    if (state.local) {
      this.#status = this.#host.translator.text("skillhub.panel.local_skill");
      this.#host.requestRender();
      return;
    }
    try {
      await this.#host.uninstall(item.market, item.id, state.scope);
      this.#status = this.#host.translator.text(
        "skillhub.panel.uninstalled",
        item.id,
      );
      if (this.#detail !== undefined) {
        this.#detail = await this.#host.detail(item.market, item.id);
      }
    } catch (err) {
      this.#status = errorMessage(err);
    }
    this.#host.requestRender();
  }

  // --- DialogController surface ---------------------------------------------

  page(): DialogPage {
    if (this.#view === "scope") return this.#scopePage();
    if (this.#view === "detail") return this.#detailPage();
    return this.#listPage();
  }

  select(value: string): void {
    const idx = Number.parseInt(value, 10);
    if (Number.isNaN(idx)) return;
    this.#cursor = idx;
    const item = this.#selectedItem();
    if (item !== undefined) void this.#openDetail(item);
  }

  submit(_value: string): void {
    // The panel has no input box; search uses inline typed text.
  }

  key(_name: string): void {
    // Printable keys are consumed by handleKey() before the Dialog router.
  }

  back(): void {
    if (this.#view === "detail") this.#backToList();
    else this.close();
  }

  #listPage(): DialogPage {
    const tr = this.#host.translator;
    const body: string[] = [];
    const tabs = this.#marketTabs();
    const mIdx = Math.max(tabs.indexOf(this.#market), 0);
    const tabParts = tabs.map((id, i) =>
      i === mIdx ? `${ACCENT}${BOLD}[${id}]${RESET}` : `[${id}]`
    );
    const catCount = this.#categories.length;
    const catParts = catCount > 0
      ? [
        this.#categoryIndex === 0
          ? `${ACCENT}${BOLD}${tr.text("skillhub.panel.cat.all")}${RESET}`
          : tr.text("skillhub.panel.cat.all"),
        ...this.#categories.map((c, i) =>
          this.#categoryIndex === i + 1
            ? `${ACCENT}${BOLD}${c.name}${RESET}`
            : c.name
        ),
      ]
      : [];
    body.push(
      `${DIM}${tr.text("skillhub.panel.tabs")}${RESET} ${tabParts.join(" ")}`,
    );
    if (catParts.length > 0) {
      body.push(
        `${DIM}${tr.text("skillhub.panel.cats")}${RESET} ${
          catParts.join(" · ")
        }`,
      );
    }
    if (this.#query !== "") {
      body.push(
        `${DIM}${tr.text("skillhub.panel.filter", this.#query)}${RESET}`,
      );
    }
    body.push("");

    const items: DialogItem[] = [];
    if (this.#loading) {
      body.push(`${DIM}${tr.text("skillhub.panel.loading")}${RESET}`);
    } else if (this.#error !== "") {
      body.push(this.#error);
    } else if (this.#tab === "installed") {
      if (this.#installed.length === 0) {
        body.push(`${DIM}${tr.text("skillhub.panel.no_installed")}${RESET}`);
      }
      const window = visibleWindow(this.#cursor, this.#installed.length, 12);
      this.#installed.forEach((row, i) => {
        if (i < window[0] || i >= window[1]) return;
        const marks: string[] = [];
        if (row.updateAvailable) marks.push(tr.text("skillhub.panel.update"));
        items.push({
          label: `${row.name} (${row.market}/${row.id})`,
          value: String(i),
          description: [
            row.scope,
            row.version,
            row.local ? tr.text("skillhub.panel.local") : marks.join(","),
          ].filter((v) => v !== "").join(" · "),
        });
      });
      if (this.#installed.length > 12) {
        body.splice(
          body.length - 1,
          0,
          `${DIM}${
            tr.text(
              "skillhub.panel.showing",
              window[0] + 1,
              window[1],
              this.#installed.length,
            )
          }${RESET}`,
        );
      }
    } else {
      if (this.#items.length === 0) {
        body.push(`${DIM}${tr.text("skillhub.panel.no_results")}${RESET}`);
      }
      const window = visibleWindow(this.#cursor, this.#items.length, 12);
      this.#items.forEach((item, i) => {
        if (i < window[0] || i >= window[1]) return;
        const badges: string[] = [];
        if (item.publisherVerified === true) {
          badges.push(tr.text("skillhub.panel.verified"));
        }
        if (item.suspicious === true) {
          badges.push(tr.text("skillhub.panel.suspicious"));
        }
        if (item.installed?.installed === true) {
          badges.push(tr.text("skillhub.panel.installed_badge"));
        }
        const downloads = item.downloads ?? 0;
        items.push({
          label: `${item.name}${
            badges.length > 0 ? ` (${badges.join(", ")})` : ""
          }`,
          value: String(i),
          description: [
            item.description,
            downloads > 0 ? tr.text("skillhub.panel.downloads", downloads) : "",
          ].filter((v) => v !== "").join(" — "),
        });
      });
      if (this.#items.length > 0 || this.#totalPages > 1) {
        body.push(
          `${DIM}${
            tr.text(
              "skillhub.panel.page",
              this.#page,
              this.#totalPages,
              this.#items.length,
            )
          }${RESET}`,
        );
      }
    }
    if (this.#status !== "") body.push("", this.#status);

    return {
      title: tr.text("skillhub.panel.title"),
      body,
      items,
      hint: tr.text(
        this.#tab === "installed"
          ? "skillhub.panel.hint.installed"
          : "skillhub.panel.hint",
      ),
    };
  }

  #detailPage(): DialogPage {
    const tr = this.#host.translator;
    const body: string[] = [];
    if (this.#detailLoading) {
      body.push(`${DIM}${tr.text("skillhub.panel.loading")}${RESET}`);
    } else if (this.#detail === undefined) {
      body.push(
        this.#error !== "" ? this.#error : tr.text("skillhub.panel.no_detail"),
      );
    } else {
      const d = this.#detail;
      body.push(`${BOLD}${d.displayName || d.name}${RESET} (${d.id})`);
      if (d.description !== "") body.push(d.description);
      body.push(
        `${DIM}${
          tr.text(
            "skillhub.panel.meta",
            d.market,
            d.version,
            d.author !== "" ? d.author : "-",
            d.category !== "" ? d.category : "-",
          )
        }${RESET}`,
      );
      if (d.installed?.installed === true) {
        const st = d.installed;
        body.push(
          `${GREEN_MARK}${
            tr.text(
              "skillhub.panel.installed_at",
              st.scope,
              st.version ?? "",
              st.updateAvailable === true
                ? tr.text("skillhub.panel.update")
                : "",
            )
          }${RESET}`,
        );
      }
      if (Array.isArray(d.tags) && d.tags.length > 0) {
        body.push(`${DIM}${d.tags.join(" · ")}${RESET}`);
      }
      if (d.readme !== undefined && d.readme !== "") {
        body.push("", readmeExcerpt(d.readme, 6));
      }
    }
    if (this.#status !== "") body.push("", this.#status);
    return {
      title: tr.text("skillhub.panel.detail_title"),
      body,
      items: [],
      hint: tr.text("skillhub.panel.hint.detail"),
    };
  }

  #scopePage(): DialogPage {
    const tr = this.#host.translator;
    const item = this.#pendingInstall;
    return {
      title: tr.text("skillhub.panel.scope_title"),
      body: [
        tr.text("skillhub.panel.scope_body", item?.name ?? ""),
        "",
      ],
      items: this.#scopeOptions().map((s, i) => ({
        ...s,
        current: i === this.#scopeCursor,
      })),
      hint: tr.text("skillhub.panel.hint.scope"),
    };
  }

  /** The selected row index in the current list view. */
  get cursor(): number {
    return this.#cursor;
  }

  #clampCursor(): void {
    const total = this.#tab === "installed"
      ? this.#installed.length
      : this.#items.length;
    if (this.#cursor >= total) this.#cursor = Math.max(total - 1, 0);
  }
}

const GREEN_MARK = "\u001B[38;5;82m";

/** First non-empty paragraph of a README, clipped to `maxLines`. */
export function readmeExcerpt(readme: string, maxLines: number): string {
  const stripped = readme
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter((l) => l !== "" && !/^[-=*`![]/.test(l));
  return stripped.slice(0, maxLines).join("\n");
}

/** Centered visible window over `total` rows. */
export function visibleWindow(
  cursor: number,
  total: number,
  limit: number,
): [number, number] {
  if (total <= 0) return [0, 0];
  if (total <= limit) return [0, total];
  let start = cursor - Math.floor(limit / 2);
  if (start < 0) start = 0;
  if (start + limit > total) start = total - limit;
  return [start, start + limit];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Convenience for callers that only need the local index shape. */
export function installedEntries(
  globalDir: string,
  projectDirs: string[],
): SkillHubInstalledEntry[] {
  return createLocalIndex(globalDir, projectDirs).list().map((s) => ({
    dir: s.dir,
    scope: s.scope,
    version: s.version ?? "",
    market: s.market ?? "",
    id: s.id ?? "",
    name: s.name ?? s.dir,
    local: s.local === true,
    updateAvailable: s.updateAvailable === true,
  }));
}
