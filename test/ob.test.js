import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "../src/ob.js";

test("parseJson parses plain JSON object", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
});

test("parseJson parses JSON array", () => {
  assert.deepEqual(parseJson("[1,2,3]"), [1, 2, 3]);
});

test("parseJson strips a leading banner line before the JSON", () => {
  assert.deepEqual(parseJson('some banner\n{"ok":true}'), { ok: true });
});

test("parseJson strips a banner before a JSON array", () => {
  assert.deepEqual(parseJson("log line\n[1,2]"), [1, 2]);
});

test("parseJson returns null for empty input", () => {
  assert.equal(parseJson(""), null);
  assert.equal(parseJson("   \n"), null);
});

test("parseJson wraps unparseable text as { raw }", () => {
  assert.deepEqual(parseJson("totally not json"), { raw: "totally not json" });
});
