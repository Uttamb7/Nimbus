import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { traceList } from "../web/trace-view.js";

test("console assets use live GraphQL data", async () => {
  const [html, script, styles] = await Promise.all([readFile("web/index.html", "utf8"), readFile("web/app.js", "utf8"), readFile("web/styles.css", "utf8")]);
  assert.match(html, /Nimbus Control/);
  assert.match(script, /serviceGraph/);
  assert.match(script, /injectFailure/);
  assert.match(script, /recentTraces/);
  assert.match(script, /incidentTraces/);
  assert.match(script, /Investigate traces/);
  assert.match(script, /Healthy baseline/);
  assert.match(styles, /--critical/);
});

test("console renders incident trace evidence and isolated errors safely", () => {
  const traces = traceList([{
    traceId: "trace-12345678",
    durationMs: 12.5,
    services: ["gateway"],
    spans: [{ parentSpanId: null, service: "gateway", operation: "<checkout>", durationMs: 12.5, error: true }],
  }], null);
  assert.match(traces, /12345678/);
  assert.match(traces, /trace-error/);
  assert.match(traces, /&lt;checkout&gt;/);
  assert.match(traceList([], "offline <now>", { errorPrefix: "Incident trace data unavailable" }), /offline &lt;now&gt;/);
});
