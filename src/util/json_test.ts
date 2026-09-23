import { assert, assertEquals } from "@std/assert";
import {
  asJsonRecord,
  optBoolean,
  optNumber,
  optString,
  optStringArray,
  optStringMap,
  parseJsonRecord,
} from "./json.ts";

Deno.test("asJsonRecord accepts objects and rejects the rest", () => {
  assertEquals(asJsonRecord({ a: 1 }), { a: 1 });
  assertEquals(asJsonRecord(null), undefined);
  assertEquals(asJsonRecord("x"), undefined);
  assertEquals(asJsonRecord(5), undefined);
  assertEquals(asJsonRecord([1]), undefined);
});

Deno.test("parseJsonRecord parses objects and rejects other shapes", () => {
  assertEquals(parseJsonRecord('{"a":"b"}'), { a: "b" });
  assertEquals(parseJsonRecord("null"), undefined);
  assertEquals(parseJsonRecord("[1]"), undefined);
  assertEquals(parseJsonRecord("not json"), undefined);
});

Deno.test("opt field readers ignore absent or mistyped fields", () => {
  const rec = parseJsonRecord(
    '{"s":"x","n":3,"b":true,"a":["p"],"m":{"k":"v"},"bad":5}',
  );
  assert(rec !== undefined);
  assertEquals(optString(rec, "s"), "x");
  assertEquals(optString(rec, "n"), undefined);
  assertEquals(optNumber(rec, "n"), 3);
  assertEquals(optNumber(rec, "s"), undefined);
  assertEquals(optBoolean(rec, "b"), true);
  assertEquals(optBoolean(rec, "bad"), undefined);
  assertEquals(optStringArray(rec, "a"), ["p"]);
  assertEquals(optStringArray(rec, "bad"), undefined);
  assertEquals(optStringMap(rec, "m"), { k: "v" });
  assertEquals(optStringMap(rec, "a"), undefined);
  assertEquals(optString(undefined, "s"), undefined);
});

Deno.test("optStringArray rejects mixed-type arrays", () => {
  const rec = parseJsonRecord('{"a":["p",5]}');
  assert(rec !== undefined);
  assertEquals(optStringArray(rec, "a"), undefined);
});
