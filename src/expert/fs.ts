//
// Go loads builtin bundles from an embed.FS and tests from testing/fstest.MapFS.
// Node has no io/fs, so a minimal read-only filesystem interface stands in for
// it: file contents are text and paths are bundle-relative slash paths.

/** One directory entry returned by ExpertFS.readDir. */
export interface ExpertFSEntry {
  name: string;
  isDir: boolean;
}

/** A read-only, slash-path filesystem over an in-memory file tree. */
export interface ExpertFS {
  /** Returns file content, or undefined when the path does not exist. */
  readFile(path: string): string | undefined;
  /** Returns directory entries, or undefined when the directory is absent. */
  readDir(dir: string): ExpertFSEntry[] | undefined;
  /** Returns {isDir} when the path exists, otherwise undefined. */
  stat(path: string): { isDir: boolean } | undefined;
}

/** Normalizes a slash path the way Go's path.Clean does for bundle lookups. */
export function cleanSlashPath(p: string): string {
  const trimmed = p.trim() === "" ? "" : p;
  const joined = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Builds an ExpertFS over an in-memory map of slash paths to file content. */
export function createMemoryFS(files: Record<string, string>): ExpertFS {
  const keys = Object.keys(files);
  const fileSet = new Set(keys);
  return {
    readFile(p: string): string | undefined {
      const key = cleanSlashPath(p);
      return fileSet.has(key) ? files[key] : undefined;
    },
    readDir(dir: string): ExpertFSEntry[] | undefined {
      const prefix = cleanSlashPath(dir);
      const entries = new Map<string, boolean>();
      for (const key of keys) {
        let rest: string;
        if (prefix === "") {
          rest = key;
        } else if (key.startsWith(prefix + "/")) {
          rest = key.slice(prefix.length + 1);
        } else {
          continue;
        }
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const isDir = slash >= 0;
        if (!entries.has(name)) entries.set(name, isDir);
      }
      if (entries.size === 0) {
        // A path that names a file (not a directory) yields no entries.
        return undefined;
      }
      return [...entries].map(([name, isDir]) => ({ name, isDir }));
    },
    stat(p: string): { isDir: boolean } | undefined {
      const key = cleanSlashPath(p);
      if (fileSet.has(key)) return { isDir: false };
      const prefix = key + "/";
      for (const candidate of keys) {
        if (candidate.startsWith(prefix)) return { isDir: true };
      }
      return undefined;
    },
  };
}
