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

test("GraphQL scopes incident traces to stored evidence time", async () => {
  const operations = new Operations({ minSamples: 1, consecutiveWindows: 1, now: () => Date.parse("2023-11-14T22:13:20.000Z") });
  await operations.observe({ source: "gateway", status: 503, durationMs: 900 });
  const [incident] = await operations.incidents();
  const expected = [{ traceId: "trace", services: ["gateway"], spans: [] }];
  const searches = [];
  const traces = { search: async (input) => {
    searches.push(input);
    return expected;
  } };
  const rootValue = root(new Topology(), operations, undefined, { role: "viewer", actor: "Reader" }, traces, () => new Date("2023-11-14T22:14:20.000Z"));
  const result = await graphql({ schema, source: `query($id:ID!){ incidentTraces(id:$id,limit:2){ traceId services } }`, variableValues: { id: incident.id }, rootValue });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.incidentTraces)), [{ traceId: "trace", services: ["gateway"] }]);
  assert.deepEqual(searches[0], {
    service: "gateway",
    limit: 2,
    startTime: "2023-11-14T22:08:20.000Z",
    endTime: "2023-11-14T22:14:20.000Z",
  });

  await operations.resolve(incident.id);
  await graphql({ schema, source: `query($id:ID!){ incidentTraces(id:$id,limit:2){ traceId } }`, variableValues: { id: incident.id }, rootValue });
  assert.equal(searches[1].endTime, incident.createdAt);

  const missing = await graphql({ schema, source: `{ incidentTraces(id:"missing"){ traceId } }`, rootValue });
  assert.match(missing.errors[0].message, /unknown incident/);
  const unauthorized = await graphql({ schema, source: `{ incidentTraces(id:"${incident.id}"){ traceId } }`, rootValue: root(new Topology(), operations, undefined, null, traces) });
  assert.match(unauthorized.errors[0].message, /viewer role required/);
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

test("GraphQL exposes the measured incident baseline", async () => {
  const operations = new Operations({ minSamples: 2, consecutiveWindows: 1, errorRateLimit: 0.2 });
  await operations.observe({ source: "gateway", status: 200, durationMs: 10 });
  await operations.observe({ source: "gateway", status: 200, durationMs: 20 });
  await operations.observe({ source: "gateway", status: 503, durationMs: 900 });

  const result = await graphql({
    schema,
    source: "{ incidents { baseline { requestCount errorRate p95LatencyMs availability } } }",
    rootValue: root(new Topology(), operations),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.data.incidents)), [{
    baseline: { requestCount: 2, errorRate: 0, p95LatencyMs: 20, availability: 1 },
  }]);
});
