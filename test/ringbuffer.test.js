import { test } from "node:test";
import assert from "node:assert/strict";
import { createRingBuffer } from "../src/ringbuffer.js";

test("push splits multi-line chunks into separate entries", () => {
  const rb = createRingBuffer(10);
  rb.push("line one\nline two\r\nline three");
  assert.deepEqual(
    rb.list().map((e) => e.line),
    ["line one", "line two", "line three"]
  );
});

test("empty lines are skipped and entries carry a timestamp", () => {
  const rb = createRingBuffer(10);
  rb.push("a\n\n\nb");
  const lines = rb.list();
  assert.deepEqual(lines.map((e) => e.line), ["a", "b"]);
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("the buffer is bounded to its limit (oldest dropped)", () => {
  const rb = createRingBuffer(3);
  for (let i = 1; i <= 5; i++) rb.push(`n${i}`);
  assert.deepEqual(rb.list().map((e) => e.line), ["n3", "n4", "n5"]);
});

test("list returns a copy, not the internal array", () => {
  const rb = createRingBuffer(5);
  rb.push("x");
  rb.list().push({ line: "mutation" });
  assert.equal(rb.list().length, 1);
});
