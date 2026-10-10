// The /skillmgr unified skill manager: one framed popup panel in the mothx
// style (rounded wire frame, checkbox list, footer counter) merging the former
// /skills listing and /skill <name> activation into one interactive overlay.
// Up/Down (or j/k) move the cursor, Space toggles a skill's activation, Enter
// applies the pending set in one pass, and Esc/q close without changes.
//
// The panel is a thin projection over the Runtime-owned skill activation path
// (TUIService.listSkills / setSkillActive): it owns cursor and pending-toggle
// state only, with no skill discovery, context assembly, or persistence of its
// own. Feature-forced builtin skills are shown as locked because their
// activation is owned by feature flags, not this panel.

import { type TUISkillView } from "./service.ts";
import { type KeyEvent } from "./keys.ts";
import type { Translator } from "./i18n.ts";
import { truncateDisplay } from "./formatters.ts";
import { clampWidth, frame, visibleRange } from "./dialog.ts";
import { ACCENT, BOLD, DIM, RESET } from "./theme.ts";

/** Max skill rows shown at once (same windowing as the /skillhub panel). */
export const SKILL_MGR_VISIBLE_ROWS = 12;

/**
 * The session surface the panel may read and mutate. Mirrors the narrow
 * SkillHubPanelHost style: async service calls plus render scheduling.
 */
export interface SkillMgrPanelHost {
  readonly translator: Translator;
  /** Feature-forced builtin skills the panel shows but cannot toggle. */
  lockedNames(): string[];
  /** The session's skill catalog with current activation state. */
  listSkills(): Promise<TUISkillView[]>;
  /** Activates or deactivates one skill (Runtime-owned). */
  setSkillActive(name: string, active: boolean): Promise<void>;
  /** Reports a settled message to the transcript when the panel closes. */
  settle(message: string, error?: boolean): void;
  requestRender(): void;
}

/** Panel state machine. Owned by the session; keys route through handleKey. */
export class SkillMgrPanel {
  #host: SkillMgrPanelHost;
  #dialog: { close(): void };
  #items: TUISkillView[] = [];
  /** Pending selection, seeded from the active skills when the list loads. */
  #selected = new Set<string>();
  #locked = new Set<string>();
  #cursor = 0;
  #message = "";
  #loading = true;
  #applying = false;
  #closed = false;

  constructor(
    host: SkillMgrPanelHost,
    dialog: { close(): void },
  ) {
    this.#host = host;
    this.#dialog = dialog;
    this.#locked = new Set(host.lockedNames());
    void this.#init();
  }

  async #init(): Promise<void> {
    const tr = this.#host.translator;
    try {
      const items = await this.#host.listSkills();
      if (this.#closed) return;
      if (items.length === 0) {
        this.close(tr.text("skills.empty"));
        return;
      }
      this.#items = items;
      // Seed the pending selection from the currently active skills so the
      // panel opens reflecting reality; Space toggles relative to that.
      for (const skill of items) {
        if (skill.active) this.#selected.add(skill.name);
      }
    } catch (err) {
      if (this.#closed) return;
      this.close(errorMessage(err), true);
      return;
    }
    this.#loading = false;
    this.#host.requestRender();
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

  /** Applies one key event. Returns true when the panel consumed it. */
  handleKey(ev: KeyEvent): boolean {
    if (this.#closed) return false;
    if (ev.type === "text") {
      switch (ev.text) {
        case "q":
          this.close();
          return true;
        case "j":
          this.#move(1);
          return true;
        case "k":
          this.#move(-1);
          return true;
        case " ":
          this.#toggleCurrent();
          return true;
        default:
          return false;
      }
    }
    switch (ev.name) {
      case "escape":
        this.close();
        return true;
      case "up":
        this.#move(-1);
        return true;
      case "down":
        this.#move(1);
        return true;
      case "space":
        this.#toggleCurrent();
        return true;
      case "enter":
        void this.#apply();
        return true;
      default:
        return false;
    }
  }

  /** The selected row index (clamped, mothx-style: no wraparound). */
  get cursor(): number {
    return this.#cursor;
  }

  #move(delta: number): void {
    if (this.#loading || this.#items.length === 0) return;
    const next = this.#cursor + delta;
    if (next < 0 || next >= this.#items.length) return;
    this.#cursor = next;
    this.#host.requestRender();
  }

  #toggleCurrent(): void {
    if (this.#loading) return;
    const skill = this.#items[this.#cursor];
    if (skill === undefined) return;
    if (this.#locked.has(skill.name)) {
      this.#message = this.#host.translator.text("skillmgr.locked", skill.name);
      this.#host.requestRender();
      return;
    }
    if (this.#selected.has(skill.name)) this.#selected.delete(skill.name);
    else this.#selected.add(skill.name);
    this.#message = "";
    this.#host.requestRender();
  }

  /**
   * Diffs the pending selection against the activation state the panel opened
   * with and applies activations and deactivations in one pass, then settles a
   * single summary line (mothx applySkillMgrSelection).
   */
  async #apply(): Promise<void> {
    if (this.#loading || this.#applying) return;
    const tr = this.#host.translator;
    const activated: string[] = [];
    const deactivated: string[] = [];
    for (const skill of this.#items) {
      if (this.#locked.has(skill.name)) continue;
      const want = this.#selected.has(skill.name);
      if (want === skill.active) continue;
      (want ? activated : deactivated).push(skill.name);
    }
    if (activated.length === 0 && deactivated.length === 0) {
      this.close(tr.text("skillmgr.no_change"));
      return;
    }
    this.#applying = true;
    try {
      for (const name of activated) {
        await this.#host.setSkillActive(name, true);
      }
      for (const name of deactivated) {
        await this.#host.setSkillActive(name, false);
      }
    } catch (err) {
      this.#applying = false;
      if (this.#closed) return;
      this.#message = errorMessage(err);
      this.#host.requestRender();
      return;
    }
    this.#applying = false;
    if (this.#closed) return;
    let message: string;
    if (activated.length > 0 && deactivated.length > 0) {
      message = tr.text(
        "skillmgr.applied_both",
        activated.join(", "),
        deactivated.join(", "),
      );
    } else if (activated.length > 0) {
      message = tr.text("skillmgr.applied_on", activated.join(", "));
    } else {
      message = tr.text("skillmgr.applied_off", deactivated.join(", "));
    }
    this.close(message);
  }

  /** Renders the panel inside its rounded wire frame (mothx layout). */
  view(terminalWidth: number): string {
    const tr = this.#host.translator;
    const width = clampWidth(terminalWidth);
    const contentWidth = Math.max(width - 6, 20);
    const lines: string[] = [
      `${BOLD}${tr.text("skillmgr.title")}${RESET}`,
      `${DIM}${tr.text("skillmgr.hint")}${RESET}`,
      `${DIM}${"─".repeat(Math.min(contentWidth, 40))}${RESET}`,
    ];
    if (this.#message !== "") {
      lines.push(truncateDisplay(this.#message, contentWidth));
    }
    if (this.#loading) {
      lines.push(`${DIM}${tr.text("skillmgr.loading")}${RESET}`);
    } else {
      const [start, end] = visibleRange(
        this.#cursor,
        this.#items.length,
        SKILL_MGR_VISIBLE_ROWS,
      );
      for (let i = start; i < end; i++) {
        lines.push(this.#row(this.#items[i], i === this.#cursor, contentWidth));
      }
      if (this.#items.length > SKILL_MGR_VISIBLE_ROWS) {
        lines.push(
          `${DIM}${
            tr.text(
              "skillmgr.showing",
              start + 1,
              end,
              this.#items.length,
            )
          }${RESET}`,
        );
      }
    }
    lines.push(
      `${DIM}${"─".repeat(Math.min(contentWidth, 40))}${RESET}`,
      `${DIM}${
        tr.text("skillmgr.counter", this.#activeCount(), this.#items.length)
      }${RESET}`,
    );
    return frame(lines, width);
  }

  #row(skill: TUISkillView, current: boolean, contentWidth: number): string {
    const pointer = current ? `${ACCENT}${BOLD}> ${RESET}` : "  ";
    const check = this.#selected.has(skill.name) ? "[x]" : "[ ]";
    const lock = this.#locked.has(skill.name)
      ? ` ${DIM}(${this.#host.translator.text("skillmgr.builtin")})${RESET}`
      : "";
    const name = current ? `${ACCENT}${BOLD}${skill.name}${RESET}` : skill.name;
    const label =
      `${pointer}${check} ${name} (${skill.source})${lock}: ${skill.description}`;
    return truncateDisplay(label, contentWidth);
  }

  #activeCount(): number {
    let count = 0;
    for (const skill of this.#items) {
      if (this.#selected.has(skill.name)) count += 1;
    }
    return count;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
