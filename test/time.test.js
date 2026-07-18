import { test } from "node:test";
import assert from "node:assert/strict";
import { localTimestamp } from "../src/time.js";

test("localTimestamp formats as YYYY-MM-DDTHH:MM:SS", () => {
  const ts = localTimestamp(new Date(2026, 0, 5, 9, 3, 7)); // local components
  assert.equal(ts, "2026-01-05T09:03:07");
});

test("localTimestamp default uses the current time and is sliceable", () => {
  const ts = localTimestamp();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  // The UI slices [11,19] for HH:MM:SS and [0,19] for the full stamp.
  assert.match(ts.slice(11, 19), /^\d{2}:\d{2}:\d{2}$/);
});
