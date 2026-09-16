export const safe = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character],
);
export const fmt = (value, digits = 1) => Number(value || 0).toFixed(digits);

export function traceList(traces, error, {
  errorPrefix = "Trace data unavailable",
  empty = "No traces found.",
} = {}) {
  if (error) return `<p class="empty">${safe(errorPrefix)}: ${safe(error)}</p>`;
  if (!traces.length) return `<p class="empty">${safe(empty)}</p>`;
  return traces.map((trace) => `<details class="trace"><summary><b>${safe(trace.traceId.slice(-8))}</b><span>${fmt(trace.durationMs)} ms · ${trace.services.map(safe).join(", ")}</span></summary>${trace.spans.map((span) => `<p class="${span.error ? "trace-error" : ""}">${span.parentSpanId ? "↳" : "•"} ${safe(span.service)} · ${safe(span.operation)} <span>${fmt(span.durationMs)} ms</span></p>`).join("")}</details>`).join("");
}
