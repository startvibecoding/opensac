import { assert } from "@std/assert";
import * as path from "@std/path";
import { gitAccessRequired, isGitDeniedPath } from "./git.ts";

Deno.test("gitAccessRequired", () => {
  assert(gitAccessRequired("git status", ""));
  assert(gitAccessRequired("cd .git", ""));
  assert(!gitAccessRequired("echo hello", ""));
  assert(!gitAccessRequired("ls -la", ""));
});

Deno.test("isGitDeniedPath", () => {
  assert(isGitDeniedPath(path.join("/a", "b", ".git")));
  assert(isGitDeniedPath("/a/b/.git/config"));
  assert(!isGitDeniedPath("/a/b/c"));
});
