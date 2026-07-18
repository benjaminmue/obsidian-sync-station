// Local timestamp in `YYYY-MM-DDTHH:MM:SS` (no timezone suffix), using the
// container's local time — which is driven by the TZ env var. Used for all
// timestamps shown in the web UI so they read consistently in the configured
// timezone. (Machine logs in logger.js keep UTC ISO on purpose.)
export function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
