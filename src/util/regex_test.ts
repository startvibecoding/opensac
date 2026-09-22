import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  compileGeneratedRegExp,
  compileUserRegExp,
  maxUserRegExpLength,
  UserRegExpError,
} from "./regex.ts";
import { globToRegex } from "../tools/globset.ts";

Deno.test("compileUserRegExp compiles ordinary patterns", () => {
  assertEquals(compileUserRegExp("a(b)c").source, "a(b)c");
  assertEquals(compileUserRegExp("foo", "i").flags, "i");
  // Bounded quantifiers stay legal.
  assertEquals(compileUserRegExp("(ab){2,3}").source, "(ab){2,3}");
  assertEquals(compileUserRegExp("(ab)+").source, "(ab)+");
});

Deno.test("compileUserRegExp rejects oversized patterns", () => {
  const err = assertThrows(
    () => compileUserRegExp("a".repeat(maxUserRegExpLength + 1)),
    UserRegExpError,
  );
  assert(err.message.includes("exceeds"));
});

Deno.test("compileUserRegExp rejects nested unbounded quantifiers", () => {
  for (
    const evil of [
      "(a+)+",
      "(a*)*",
      "(a+)+$",
      "([a-z]+)*x",
      "(a|b*)*",
      "(a{2,})*",
    ]
  ) {
    assertThrows(
      () => compileUserRegExp(evil),
      UserRegExpError,
      "nested unbounded quantifiers",
    );
  }
});

Deno.test("compileUserRegExp keeps escapes and classes legal", () => {
  assertEquals(compileUserRegExp("\\(a\\+\\)\\+").source, "\\(a\\+\\)\\+");
  assertEquals(compileUserRegExp("[(+*]").source, "[(+*]");
  // `?` and bounded repeats are not unbounded.
  assertEquals(compileUserRegExp("(a*)?").source, "(a*)?");
});

Deno.test("compileUserRegExp reports JS syntax errors as UserRegExpError", () => {
  const err = assertThrows(
    () => compileUserRegExp("(unclosed"),
    UserRegExpError,
  );
  assert(err.message.includes("invalid regex"));
});

Deno.test("glob-generated patterns compile unchanged and skip user limits", () => {
  for (
    const glob of ["**/*.ts", "src/**/mod.ts", "*.js", "!node_modules/**"]
  ) {
    const source = globToRegex(glob.startsWith("!") ? glob.slice(1) : glob);
    compileGeneratedRegExp(source);
  }
  // Generated sources are not subject to the user-pattern length cap.
  const longGlob = "*".repeat(maxUserRegExpLength + 1);
  compileGeneratedRegExp(globToRegex(longGlob));
});
