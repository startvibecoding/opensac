import { Registry, type Tool, type ToolContext, type ToolResult } from "./tool.ts";
import { createTextToolResult } from "./tool.ts";

/** Lists directory contents. */
export class LsTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "ls";
  }

  description(): string {
    return "List directory contents with details. Shows files and directories with sizes and types.";
  }

  promptSnippet(): string {
    return "List directory contents (preferred for directory inspection)";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: current directory)",
        },
      },
    };
  }

  execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): ToolResult {
    let dirPath = this.#registry.getWorkDir();
    const v = params["path"];
    if (typeof v === "string" && v !== "") {
      try {
        dirPath = this.#registry.resolvePath(v);
      } catch (err) {
        throw new Error(`invalid path: ${messageOf(err)}`);
      }
    }

    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dirPath)];
    } catch (err) {
      throw new Error(`read directory: ${messageOf(err)}`);
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    let sb = "";
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".")) continue;

      let info: Deno.FileInfo;
      try {
        info = Deno.statSync(join(dirPath, name));
      } catch {
        continue;
      }

      if (entry.isDirectory) {
        sb += `  📁 ${name}/\n`;
      } else {
        sb += `  📄 ${name} (${formatSize(info.size)})\n`;
      }
    }

    if (sb === "") {
      return createTextToolResult("(empty directory)");
    }
    return createTextToolResult(sb);
  }
}

function join(dir: string, name: string): string {
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)}KB`;
  return `${bytes}B`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
