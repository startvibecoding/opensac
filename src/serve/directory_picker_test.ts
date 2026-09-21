// Ported from internal/serve/native_directory_picker_test.go.

import { assertEquals, assertStringIncludes } from "@std/assert";

import {
  appleScriptString,
  runDirectoryPickerCommand,
  windowsDirectoryPickerScript,
} from "./directory_picker.ts";

// The Windows picker must force UTF-8 stdout. Windows PowerShell 5.1
// otherwise encodes redirected output with the ANSI/OEM code page, so a
// selected Chinese or full-width directory name reaches the host as invalid
// UTF-8 and the path is corrupted.
Deno.test("Windows directory picker script forces UTF-8 output", () => {
  const script = windowsDirectoryPickerScript;
  const encIdx = script.indexOf(
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  );
  if (encIdx === -1) {
    throw new Error(
      "script must set UTF-8 console output encoding before writing the selection",
    );
  }
  const writeIdx = script.indexOf("[Console]::Write($dialog.SelectedPath)");
  if (writeIdx === -1) {
    throw new Error(
      "script must write the selected path with [Console]::Write",
    );
  }
  if (encIdx > writeIdx) {
    throw new Error(
      "UTF-8 output encoding must be set before the selection is written",
    );
  }
  assertStringIncludes(
    script,
    "$env:MOTHX_DIRECTORY_PICKER_PATH",
    "default path must arrive through the UTF-16 environment block",
  );
});

// runDirectoryPickerCommand may only strip the trailing newline that picker
// tools append. Directory names on Windows and Unix can legitimately contain
// (and on Unix start/end with) spaces or full-width characters such as U+3000;
// Unicode-aware trimming would silently alter the selected path.
Deno.test({
  name: "runDirectoryPickerCommand keeps non-ASCII path bytes",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const want = "D:\\项目　目录　";
    const got = await runDirectoryPickerCommand(
      new AbortController().signal,
      "printf",
      ["%s\n", want],
    );
    assertEquals(
      got,
      want,
      "trailing full-width space must survive",
    );
  },
});

Deno.test("appleScriptString escapes quotes and backslashes", () => {
  assertEquals(
    appleScriptString('a"b\\c\rd\ne'),
    'a\\"b\\\\c\\rd\\ne',
  );
});
