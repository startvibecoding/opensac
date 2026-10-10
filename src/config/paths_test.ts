import { assertEquals } from "../compat/assert.ts";
import { projectDirName, projectPath, projectPathFor } from "./paths.ts";
import { test } from "#testing";

test("project directory name stays stable", () => {
  assertEquals(projectDirName, ".opensac");
});

test("projectPathFor joins under the given cwd", () => {
  assertEquals(
    projectPathFor("/work/repo", "rules.md"),
    "/work/repo/.opensac/rules.md",
  );
  assertEquals(
    projectPathFor("/work/repo", "experts", "team", "expert.json"),
    "/work/repo/.opensac/experts/team/expert.json",
  );
});

test("projectPathFor treats an empty cwd as the current directory", () => {
  assertEquals(projectPathFor("", "rule.md"), ".opensac/rule.md");
  assertEquals(projectPath("rule.md"), ".opensac/rule.md");
});
