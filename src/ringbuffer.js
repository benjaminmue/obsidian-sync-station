// Small bounded, timestamped line buffer shared by the sync and backup log
// tails. Splits multi-line writes so each stdout chunk becomes one entry.
// Timestamps are local (container TZ) so the UI reads consistently.

import { localTimestamp } from "./time.js";

export function createRingBuffer(limit = 200) {
  const items = [];
  return {
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        items.push({ ts: localTimestamp(), line });
        if (items.length > limit) items.shift();
      }
    },
    list() {
      return items.slice();
    },
  };
}
