import { assert } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { gitAccessRequired, isGitDeniedPath } from "./git.ts";
import { test } from "#testing";

test("gitAccessRequired", () => {
  assert(gitAccessRequired("git status", ""));
  assert(gitAccessRequired("cd .git", ""));
  assert(!gitAccessRequired("echo hello", ""));
  assert(!gitAccessRequired("ls -la", ""));
});

test("isGitDeniedPath", () => {
  assert(isGitDeniedPath(path.join("/a", "b", ".git")));
  assert(isGitDeniedPath("/a/b/.git/config"));
  assert(!isGitDeniedPath("/a/b/c"));
});
