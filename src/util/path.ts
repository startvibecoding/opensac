import * as path from "@std/path";

/**
 * Returns an absolute path after resolving all existing components. Missing
 * descendants are retained beneath the resolved nearest existing ancestor.
 */
export async function resolvePathWithExistingSymlinks(
  p: string,
): Promise<string> {
  const abs = path.resolve(path.normalize(p));

  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      await Deno.lstat(current);
      const resolved = await Deno.realPath(current);
      return path.join(resolved, ...missing);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("no existing ancestor");
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Reports whether `candidate` is equal to or below `parent` after resolving all
 * existing symlinks in both paths.
 */
export async function isWithinPath(
  parent: string,
  candidate: string,
): Promise<boolean> {
  const resolvedParent = await resolvePathWithExistingSymlinks(parent);
  const resolvedCandidate = await resolvePathWithExistingSymlinks(candidate);
  const rel = path.relative(resolvedParent, resolvedCandidate);
  return rel !== ".." && !rel.startsWith(".." + path.SEPARATOR);
}
