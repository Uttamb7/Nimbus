import test from "node:test";
import assert from "node:assert/strict";
import { graphql } from "graphql";
import { root, schema } from "../src/schema.js";
import { Topology } from "../src/topology.js";
import { Operations } from "../src/operations.js";

test("GraphQL exposes observed edges", async () => {
  const topology = new Topology();
  const operations = new Operations();
  const observation = { source: "gateway", destination: "identity-api", status: 200, durationMs: 12 };
  topology.observe(observation);
  await operations.observe(observation);
  const result = await graphql({ schema, source: "{ serviceGraph { source destination requestCount averageLatencyMs } services { name health metrics { requestCount p95LatencyMs } } systemHealth { status healthy } }", rootValue: root(topology, operations) });
  assert.deepEqual({ ...result.data.serviceGraph[0] }, { source: "gateway", destination: "identity-api", requestCount: 1, averageLatencyMs: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.services[0])), { name: "gateway", health: "HEALTHY", metrics: { requestCount: 1, p95LatencyMs: 12 } });
  assert.equal(result.data.systemHealth.status, "HEALTHY");
});

test("GraphQL exposes traces to viewers", async () => {
  const expected = [{ traceId: "trace", services: ["gateway"], spans: [] }];
  const traces = { recent: async (input) => { assert.deepEqual(input, { service: "gateway", limit: 2 }); return expected; } };
  const result = await graphql({ schema, source: `{ recentTraces(service: "gateway", limit: 2) { traceId services } }`, rootValue: root(new Topology(), new Operations(), undefined, { role: "viewer", actor: "Reader" }, traces) });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.recentTraces)), [{ traceId: "trace", services: ["gateway"] }]);
});

test("GraphQL exposes the stored incident snapshot", async () => {
  const topology = new Topology();
  const operations = new Operations({ minSamples: 1, consecutiveWindows: 1 });
  await operations.observe(
    { source: "gateway", destination: "orders", status: 503, durationMs: 900 },
    { affectedServices: ["gateway", "orders"] },
  );
  topology.observe({ source: "gateway", destination: "later", status: 200, durationMs: 1 });

  const result = await graphql({
    schema,
    source: "{ incidents { affectedServices evidence { requestCount errorRate p95LatencyMs availability } } }",
    rootValue: root(topology, operations),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.data.incidents)), [{
    affectedServices: ["gateway", "orders"],
    evidence: { requestCount: 1, errorRate: 1, p95LatencyMs: 900, availability: 0 },
  }]);
});
