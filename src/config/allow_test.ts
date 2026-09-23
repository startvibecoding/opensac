import { assert } from "@std/assert";
import * as path from "@std/path";
import {
  addBashCommand,
  addBashPrefix,
  addEditPath,
  type AllowConfig,
  getAutoEdit,
  globalAllowPath,
  loadAllow,
  matchBashCommand,
  matchEditPath,
  matchGlob,
  normalizeMatchPath,
  projectAllowPath,
  removeEditPath,
  saveGlobalAutoEdit,
  saveGlobalAutoEditValue,
  saveProject,
  setAutoEdit,
  setGlobalAutoEdit,
  setProjectAutoEdit,
} from "./mod.ts";

function withTempAllowPaths(fn: () => void): void {
  const tmp = Deno.makeTempDirSync({ prefix: "allow-" });
  const prevWd = Deno.cwd();
  const prevDir = Deno.env.get("OPENSAC_DIR");
  Deno.chdir(tmp);
  Deno.env.set("OPENSAC_DIR", path.join(tmp, "global"));
  try {
    fn();
  } finally {
    Deno.chdir(prevWd);
    if (prevDir === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", prevDir);
  }
}

Deno.test("matchGlob", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.go", "main.go", true],
    ["*.go", "dir/main.go", false],
    ["**/*.go", "dir/main.go", true],
    ["**/*.go", "main.go", true],
    ["internal/**", "internal/agent/agent.go", true],
    ["internal/**", "internal", false],
    ["internal/**", "cmd/main.go", false],
    ["docs/**/*.md", "docs/en/changelog.md", true],
    ["docs/**/*.md", "docs/changelog.md", true],
    ["docs/**/*.md", "docs/en/sub/x.md", true],
    ["src/*", "src/a", true],
    ["src/*", "src/a/b", false],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
    ["./*.go", "main.go", true],
  ];
  for (const [pattern, p, want] of cases) {
    assert(
      matchGlob(normalizeMatchPath(pattern), normalizeMatchPath(p)) === want,
      `matchGlob(${pattern}, ${p})`,
    );
  }
});

Deno.test("allow edit path ops", () => {
  const c: AllowConfig = {};
  assert(addEditPath(c, "internal/**"));
  assert(!addEditPath(c, "internal/**"));
  assert(matchEditPath(c, "internal/agent/agent.go"));
  assert(!matchEditPath(c, "cmd/main.go"));
  assert(removeEditPath(c, "internal/**"));
  assert(!matchEditPath(c, "internal/agent/agent.go"));
});

Deno.test("allow bash command ops", () => {
  const c: AllowConfig = {};
  assert(addBashCommand(c, "go test ./internal/tui"));
  assert(!addBashCommand(c, "go test ./internal/tui"));
  assert(matchBashCommand(c, "go test ./internal/tui"));
  assert(!matchBashCommand(c, "go test ./internal/config"));
  assert(addBashPrefix(c, "go test "));
  assert(!addBashPrefix(c, "go test "));
  assert(matchBashCommand(c, "go test ./internal/config"));
  assert(!matchBashCommand(c, "go env"));
});

Deno.test("allow autoEdit flag", () => {
  const c: AllowConfig = { autoEdit: true };
  assert(getAutoEdit(c));
  setAutoEdit(c, false);
  assert(!getAutoEdit(c));
  setAutoEdit(c, true);
  assert(getAutoEdit(c));
});

Deno.test("loadAllow defaults autoEdit on", () => {
  withTempAllowPaths(() => {
    assert(getAutoEdit(loadAllow()));
  });
});

Deno.test("allow global explicit false overrides default", () => {
  withTempAllowPaths(() => {
    Deno.mkdirSync(path.dirname(globalAllowPath()), { recursive: true });
    Deno.writeTextFileSync(globalAllowPath(), `{"autoEdit":false}`);
    assert(!getAutoEdit(loadAllow()));
  });
});

Deno.test("allow project editPaths do not persist inherited global autoEdit", () => {
  withTempAllowPaths(() => {
    Deno.mkdirSync(path.dirname(globalAllowPath()), { recursive: true });
    Deno.writeTextFileSync(globalAllowPath(), `{"autoEdit":true}`);
    const c = loadAllow();
    assert(getAutoEdit(c));
    assert(addEditPath(c, "internal/**"));
    saveProject(c);
    const data = Deno.readTextFileSync(projectAllowPath());
    assert(
      !data.includes("autoEdit"),
      "project allow.json must not persist inherited autoEdit",
    );

    setAutoEdit(c, false);
    saveGlobalAutoEdit(c);
    assert(!getAutoEdit(loadAllow()));
  });
});

Deno.test("allow project bash rules persist and reload", () => {
  withTempAllowPaths(() => {
    const c: AllowConfig = {};
    assert(addBashCommand(c, "make test"));
    assert(addBashPrefix(c, "go test "));
    saveProject(c);
    const text = Deno.readTextFileSync(projectAllowPath());
    assert(text.includes('"bashCommands"') && text.includes('"make test"'));
    assert(text.includes('"bashPrefixes"') && text.includes('"go test "'));
    const reloaded = loadAllow();
    assert(matchBashCommand(reloaded, "make test"));
    assert(matchBashCommand(reloaded, "go test ./internal/tui"));
    assert(!text.includes("autoEdit"));
  });
});

Deno.test("allow project explicit false overrides global autoEdit", () => {
  withTempAllowPaths(() => {
    Deno.mkdirSync(path.dirname(globalAllowPath()), { recursive: true });
    Deno.mkdirSync(path.dirname(projectAllowPath()), { recursive: true });
    Deno.writeTextFileSync(globalAllowPath(), `{"autoEdit":true}`);
    Deno.writeTextFileSync(
      projectAllowPath(),
      `{"autoEdit":false,"editPaths":["internal/**"]}`,
    );
    const c = loadAllow();
    assert(!getAutoEdit(c));
    assert(matchEditPath(c, "internal/agent/agent.go"));
  });
});

Deno.test("allow saveProject persists explicit false", () => {
  withTempAllowPaths(() => {
    const c: AllowConfig = {};
    setProjectAutoEdit(c, false);
    saveProject(c);
    const data = Deno.readTextFileSync(projectAllowPath());
    assert(data.includes('"autoEdit": false'), data);
  });
});

Deno.test("allow global autoEdit does not override project effective state", () => {
  withTempAllowPaths(() => {
    Deno.mkdirSync(path.dirname(globalAllowPath()), { recursive: true });
    Deno.mkdirSync(path.dirname(projectAllowPath()), { recursive: true });
    Deno.writeTextFileSync(globalAllowPath(), `{"autoEdit":true}`);
    Deno.writeTextFileSync(projectAllowPath(), `{"autoEdit":true}`);
    const c = loadAllow();
    const effective = setGlobalAutoEdit(c, false);
    assert(effective && getAutoEdit(c));
    saveGlobalAutoEditValue(false);
    const data = Deno.readTextFileSync(globalAllowPath());
    assert(data.includes('"autoEdit": false'), data);
  });
});
