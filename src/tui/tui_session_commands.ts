// Interactive TUI slash-command implementations that need a live session or
// OS-level access: provider listing (/auth, /settings), default-model settings,
// TUI language, cron management, /systeminit prompt submission, clipboard
// image attachment, and the /btw side query.
//
// Each function is a thin translation of the Go handler onto the Deno port's
// shared modules. The TUI never builds provider content, opens raw databases,
// or owns a second agent loop: clipboard bytes go through Runtime
// `prepareInput`, /systeminit reuses the shared prompt path, /btw runs as a
// Core-owned transient side query, and cron goes through the shared SQLite
// store.

import * as path from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import {
  getSessionDir,
  isProjectDir,
  loadProjectSettingsSparse,
  loadSettings,
} from "../config/settings.ts";
import { createSQLiteCronStore } from "../cron/sqlite_store.ts";
import type { CronStore } from "../cron/cron.ts";
import { ATTACHMENT_IMAGE } from "../agentruntime/attachment.ts";
import { prompt as systemInitPrompt } from "../systeminit/systeminit.ts";
import { openFile } from "../platform/platform.ts";
import { localTimeZone, utcOffset } from "./i18n.ts";
import type { CommandResult } from "./commands.ts";
import type { TUIPreparedInput } from "./service.ts";
import type { TUISession } from "./tui_session.ts";

/**
 * The narrow session view these commands need. `TUISession` satisfies it
 * structurally, and tests may supply a minimal stand-in without a live Runtime.
 */
export interface TuiSessionLike {
  readonly translator: TUISession["translator"];
  readonly workDir: string;
  readonly mode: string;
  readonly busy: boolean;
  readonly multiAgent: boolean;
  readonly providerName: string;
  readonly modelID: string;
  readonly thinkingLevel: TUISession["thinkingLevel"];
  readonly service: TUISession["service"];
  readonly controller: TUISession["controller"];
  readonly input: TUISession["input"];
  currentSessionID(): string;
  setMode(mode: string): void;
  submitPrompt(text: string): Promise<void>;
  addPreparedInput(prepared: TUIPreparedInput): void;
}

/** Clipboard images are capped like the Go TUI (20 MiB). */
const PASTED_IMAGE_MAX_BYTES = 20 << 20;

export class TuiSessionCommands {
  #session: TuiSessionLike;
  #cronStore: CronStore | undefined;
  #pastedImagePath = "";
  #pastedImageCounter = 0;
  #btwActive = false;

  constructor(session: TuiSessionLike) {
    this.#session = session;
  }

  get pastedImagePath(): string {
    return this.#pastedImagePath;
  }

  get btwActive(): boolean {
    return this.#btwActive;
  }

  // --- Providers (/auth, /settings) -----------------------------------------

  /** Lists configured providers with a masked credential state. */
  async showProviders(): Promise<string> {
    const tr = this.#session.translator;
    // The provider/model catalog is the secret-safe Core projection; the TUI
    // only renders it and never reads provider credentials itself.
    const view = await this.#session.service.settings();
    const sorted = [...view.providers].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    if (sorted.length === 0) return tr.text("auth.no_providers");
    const lines = [tr.text("auth.providers_title", sorted.length)];
    for (const provider of sorted) {
      const state = provider.apiKeyConfigured
        ? tr.text("auth.provider_configured")
        : tr.text("auth.provider_unconfigured");
      lines.push(
        tr.text(
          "auth.provider_entry",
          provider.name,
          state,
          `${provider.modelCount} models`,
        ),
      );
    }
    lines.push("", tr.text("auth.usage"));
    return lines.join("\n");
  }

  // --- Default model (/defaultModel) ----------------------------------------

  async setDefaultModel(parts: string[]): Promise<CommandResult> {
    await Promise.resolve();
    const tr = this.#session.translator;
    let scope = "global";
    if (parts.length > 2) {
      return { message: tr.text("settings.usage"), error: true };
    }
    if (parts.length === 2) {
      const requested = parts[1].toLowerCase();
      if (requested !== "global" && requested !== "project") {
        return { message: tr.text("settings.usage"), error: true };
      }
      scope = requested;
    }
    if (scope === "project" && !isProjectDir(this.#session.workDir)) {
      return { message: tr.text("settings.project_unavailable"), error: true };
    }
    try {
      const updates = {
        defaultProvider: this.#session.providerName,
        defaultModel: this.#session.modelID,
      };
      // Settings edits flow through the service so the Core refreshes too.
      await this.#session.service.updateSettings({
        scope: scope as "global" | "project",
        updates,
      });
      return {
        message: tr.text(
          "settings.default_model_saved",
          `${updates.defaultProvider}/${updates.defaultModel}`,
          scope,
        ),
      };
    } catch (err) {
      return {
        message: tr.text("settings.save_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- TUI language (/tuilang) ----------------------------------------------

  async tuiLang(parts: string[]): Promise<CommandResult> {
    const tr = this.#session.translator;
    const configured = (await this.#session.service.getSettings()).tuilang ??
      "auto";
    if (parts.length === 1) {
      // Go MsgTUILangStatus: configured, effective language, UTC offset, and
      // whether the value comes from project or global settings.
      const offset = utcOffset(new Date(), localTimeZone());
      let source = "global";
      try {
        const project = loadProjectSettingsSparse();
        if ((project.tuilang ?? "").trim() !== "") source = "project";
      } catch {
        // No project settings: global source.
      }
      return {
        message: tr.text(
          "tuilang.status",
          configured,
          tr.language,
          `${offset}  source=${source}`,
        ),
      };
    }
    let scope = "global";
    let value = "";
    if (parts.length === 2) {
      value = parts[1];
    } else if (parts.length === 3) {
      scope = parts[1].toLowerCase();
      value = parts[2];
    } else {
      return { message: tr.text("tuilang.usage"), error: true };
    }
    if (scope !== "global" && scope !== "project") {
      return { message: tr.text("tuilang.usage"), error: true };
    }
    if (value !== "auto" && value !== "zh" && value !== "en") {
      return { message: tr.text("tuilang.usage"), error: true };
    }
    if (scope === "project" && !isProjectDir(this.#session.workDir)) {
      return { message: tr.text("tuilang.project_unavailable"), error: true };
    }
    try {
      // Settings edits flow through the service so the Core refreshes too.
      await this.#session.service.updateSettings({
        scope: scope as "global" | "project",
        updates: { tuilang: value },
      });
      return {
        message: tr.text("tuilang.saved", scope, value, tr.language),
      };
    } catch (err) {
      return {
        message: tr.text("tuilang.save_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Cron (/cron) ---------------------------------------------------------

  #cron(): CronStore | undefined {
    if (this.#cronStore === undefined) {
      try {
        // The shared session store root comes from the one config resolver
        // (`config.getSessionDir`), never from a session/persistence handle.
        this.#cronStore = createSQLiteCronStore(
          getSessionDir(loadSettings()),
        );
      } catch {
        this.#cronStore = undefined;
      }
    }
    return this.#cronStore;
  }

  cron(parts: string[]): CommandResult {
    const tr = this.#session.translator;
    if (!this.#session.multiAgent) {
      return { message: tr.text("cron.requires_multi_agent"), error: true };
    }
    const store = this.#cron();
    if (store === undefined) {
      return { message: tr.text("cron.store_unavailable"), error: true };
    }
    const sub = parts[1] ?? "";
    const usage = "/cron add|list|enable|disable|remove|run";
    try {
      switch (sub) {
        case "add": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", "/cron add <description>"),
              error: true,
            };
          }
          const desc = parts.slice(2).join(" ");
          const job = store.create({
            name: desc,
            prompt: desc,
            enabled: true,
            mode: this.#session.mode,
            sessionId: this.#session.currentSessionID(),
            workDir: this.#session.workDir,
          });
          return {
            message: tr.text("cron.created", job.name ?? desc, job.id ?? ""),
          };
        }
        case "list": {
          const jobs = store.list();
          if (jobs.length === 0) return { message: tr.text("cron.list_empty") };
          const lines = [tr.text("cron.list_title", jobs.length)];
          for (const job of jobs) {
            const status = job.lastStatus === "failed"
              ? "[failed]"
              : job.enabled === false
              ? "[paused]"
              : "[ok]";
            lines.push(
              tr.text(
                "cron.entry",
                status,
                job.id ?? "",
                job.name ?? "",
                job.runCount ?? 0,
              ),
            );
          }
          return { message: lines.join("\n") };
        }
        case "enable":
        case "disable": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", `/cron ${sub} <id>`),
              error: true,
            };
          }
          const job = store.get(parts[2]);
          job.enabled = sub === "enable";
          store.update(job);
          return {
            message: tr.text(
              "cron.changed",
              job.id ?? parts[2],
              tr.text(
                sub === "enable"
                  ? "cron.changed.enabled"
                  : "cron.changed.disabled",
              ),
            ),
          };
        }
        case "remove": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", "/cron remove <id>"),
              error: true,
            };
          }
          store.delete(parts[2]);
          return {
            message: tr.text(
              "cron.changed",
              parts[2],
              tr.text("cron.changed.removed"),
            ),
          };
        }
        case "run": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", "/cron run <id>"),
              error: true,
            };
          }
          const job = store.get(parts[2]);
          // Clearing lastRun makes the next scheduler tick treat it as due.
          job.lastRun = null;
          store.update(job);
          return { message: tr.text("cron.triggered", job.id ?? parts[2]) };
        }
        default:
          return { message: tr.text("commands.usage", usage), error: true };
      }
    } catch (err) {
      return {
        message: tr.text("cron.list_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- /systeminit ----------------------------------------------------------

  async systemInit(cmd: string): Promise<CommandResult> {
    const tr = this.#session.translator;
    if (this.#session.busy) {
      return { message: tr.text("systeminit.running"), error: true };
    }
    const extra = cmd.trim().replace(/^\/systeminit/, "").trim();
    if (this.#session.mode === "plan") {
      this.#session.setMode("agent");
      this.#session.controller.addMessage(
        tr.text("systeminit.switched_mode"),
        "plain",
      );
    }
    // The question tool is only available in plan/agent modes.
    const interactive = this.#session.mode !== "yolo" &&
      this.#session.mode !== "os";
    const prompt = systemInitPrompt(interactive, extra);
    await this.#session.submitPrompt(prompt);
    return {
      message: tr.text(
        interactive ? "systeminit.interactive" : "systeminit.automatic",
      ),
    };
  }

  // --- /paste-image ---------------------------------------------------------

  async pasteImage(): Promise<CommandResult> {
    const tr = this.#session.translator;
    let bytes: Uint8Array | null;
    try {
      bytes = await readClipboardImage();
    } catch (err) {
      return {
        message: tr.text("paste_image.failed", (err as Error).message),
        error: true,
      };
    }
    if (bytes === null || bytes.length === 0) {
      return { message: tr.text("paste_image.no_png") };
    }
    if (bytes.length > PASTED_IMAGE_MAX_BYTES) {
      return {
        message: tr.text(
          "paste_image.failed",
          `image too large: ${bytes.length} bytes`,
        ),
        error: true,
      };
    }
    try {
      const prepared = await this.#session.service.prepareInput({
        sessionId: this.#session.currentSessionID(),
        name: "clipboard.png",
        mediaType: "image/png",
        contentBase64: encodeBase64(bytes),
        kind: ATTACHMENT_IMAGE,
      });
      this.#session.addPreparedInput(prepared);
      this.#pastedImageCounter++;
      this.#pastedImagePath = path.join(
        this.#session.workDir,
        prepared.relativePath,
      );
      const label = tr.text(
        "paste_image.path",
        this.#pastedImageCounter,
        prepared.relativePath,
      );
      this.#session.input.insertText(label);
      return {
        message: [
          tr.text("paste_image.pasted", prepared.relativePath),
          tr.text("paste_image.preview_hint"),
        ].join("\n"),
      };
    } catch (err) {
      return {
        message: tr.text("paste_image.failed", (err as Error).message),
        error: true,
      };
    }
  }

  /** Opens the most recently pasted image in the OS viewer (Ctrl+R). */
  previewPastedImage(): CommandResult {
    const tr = this.#session.translator;
    if (this.#pastedImagePath === "") {
      return { message: tr.text("paste_image.no_image") };
    }
    try {
      openFile(this.#pastedImagePath);
      return { message: tr.text("paste_image.opened", this.#pastedImagePath) };
    } catch (err) {
      return {
        message: tr.text(
          "paste_image.open_failed",
          this.#pastedImagePath,
          (err as Error).message,
        ),
        error: true,
      };
    }
  }

  // --- /btw -----------------------------------------------------------------

  async handleBTW(cmd: string): Promise<CommandResult> {
    const tr = this.#session.translator;
    const question = cmd.trim().replace(/^\/btw/, "").trim();
    if (question === "") return { message: tr.text("btw.usage") };
    if (this.#btwActive) {
      return { message: tr.text("btw.already_running"), error: true };
    }
    this.#btwActive = true;
    try {
      // The side query is a Core-owned transient agent over a read-only tool
      // registry; the answer never enters the session history.
      const result = await this.#session.service.askTransient({
        sessionId: this.#session.currentSessionID(),
        question,
        providerName: this.#session.providerName,
        modelID: this.#session.modelID,
        thinkingLevel: this.#session.thinkingLevel,
      });
      const answer = result.answer.trim();
      return {
        message: [
          tr.text("btw.title", question),
          "",
          answer === "" ? tr.text("btw.thinking") : answer,
        ].join("\n"),
      };
    } catch (err) {
      return {
        message: tr.text("btw.error", (err as Error).message),
        error: true,
      };
    } finally {
      this.#btwActive = false;
    }
  }
}

/** Reads a PNG from the system clipboard; null when none is present. */
export async function readClipboardImage(): Promise<Uint8Array | null> {
  const os = Deno.build.os;
  if (os === "darwin") {
    return await runCapture("pngpaste", ["-"]);
  }
  if (os === "windows") {
    return await readWindowsClipboardPNG();
  }
  // Linux: prefer Wayland, then X11.
  if ((Deno.env.get("WAYLAND_DISPLAY") ?? "") !== "") {
    const viaWl = await runCapture("wl-paste", ["--type", "image/png"]);
    if (viaWl !== null) return viaWl;
  }
  return await runCapture("xclip", [
    "-selection",
    "clipboard",
    "-t",
    "image/png",
    "-o",
  ]);
}

/** Runs a clipboard helper; null when it is missing or returns nothing. */
async function runCapture(
  program: string,
  args: string[],
): Promise<Uint8Array | null> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(program, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch {
    // Helper not installed: treat as "no image".
    return null;
  }
  if (!output.success || output.stdout.length === 0) return null;
  return output.stdout;
}

/** Reads a clipboard PNG through PowerShell on Windows. */
async function readWindowsClipboardPNG(): Promise<Uint8Array | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $image) { exit 2 }",
    "$stream = New-Object System.IO.MemoryStream",
    "$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Convert]::ToBase64String($stream.ToArray())",
  ].join("; ");
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("powershell.exe", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch {
    return null;
  }
  if (output.code === 2 || !output.success) return null;
  const base64 = new TextDecoder().decode(output.stdout).trim();
  if (base64 === "") return null;
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
