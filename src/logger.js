// Minimal structured logger. Writes single-line JSON to stdout so container
// log viewers (Unraid, docker logs) stay greppable.

function emit(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(JSON.stringify(line) + "\n");
}

export const log = {
  info: (msg, extra) => emit("info", msg, extra),
  warn: (msg, extra) => emit("warn", msg, extra),
  error: (msg, extra) => emit("error", msg, extra),
};
