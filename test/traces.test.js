import test from "node:test";
import assert from "node:assert/strict";
import { Traces } from "../src/traces.js";

const rawTrace = {
  traceID: "0123456789abcdef0123456789abcdef",
  processes: { p1: { serviceName: "gateway" }, p2: { serviceName: "inventory-api" } },
  spans: [
    { spanID: "1111111111111111", processID: "p1", operationName: "POST /checkout", startTime: 1_700_000_000_000_000, duration: 12_500, tags: [{ key: "http.response.status_code", value: 202 }] },
    { spanID: "2222222222222222", processID: "p2", operationName: "GET /reserve", startTime: 1_700_000_000_002_000, duration: 4_000, references: [{ refType: "CHILD_OF", spanID: "1111111111111111" }], tags: [{ key: "error", value: true }] },
  ],
};

test("recent traces maps bounded Jaeger data without span tags", async () => {
  let requested;
  const traces = new Traces({ baseUrl: "http://jaeger:16686", request: async (url) => { requested = url; return new Response(JSON.stringify({ data: [rawTrace] })); } });
  const result = await traces.recent({ service: "gateway", limit: 3 });
  assert.equal(requested.href, "http://jaeger:16686/api/traces?service=gateway&limit=3&lookback=1h");
  assert.deepEqual(result[0].services, ["gateway", "inventory-api"]);
  assert.equal(result[0].durationMs, 12.5);
  assert.deepEqual(result[0].spans[1], { spanId: "2222222222222222", parentSpanId: "1111111111111111", service: "inventory-api", operation: "GET /reserve", startTime: "2023-11-14T22:13:20.002Z", durationMs: 4, error: true });
  assert.equal("tags" in result[0].spans[0], false);
});

test("recent traces validates queries and backend responses", async () => {
  const traces = new Traces({ baseUrl: "http://jaeger:16686", request: async () => new Response("failure", { status: 503 }) });
  await assert.rejects(traces.recent({ service: "missing" }), /unknown service/);
  await assert.rejects(traces.recent({ service: "gateway", limit: 21 }), /1-20/);
  await assert.rejects(traces.recent({ service: "gateway" }), /returned 503/);
  await assert.rejects(new Traces({ baseUrl: "http://jaeger:16686", request: async () => new Response("{}") }).recent({ service: "gateway" }), /malformed/);
  await assert.rejects(new Traces({ baseUrl: "http://jaeger:16686", request: async () => { throw new Error("offline"); } }).recent({ service: "gateway" }), /unavailable: offline/);
  await assert.rejects(new Traces().recent({ service: "gateway" }), /not configured/);
});
