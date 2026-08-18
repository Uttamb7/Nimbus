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
  operations.observe(observation);
  const result = await graphql({ schema, source: "{ serviceGraph { source destination requestCount averageLatencyMs } services { name health metrics { requestCount p95LatencyMs } } systemHealth { status healthy } }", rootValue: root(topology, operations) });
  assert.deepEqual({ ...result.data.serviceGraph[0] }, { source: "gateway", destination: "identity-api", requestCount: 1, averageLatencyMs: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.services[0])), { name: "gateway", health: "HEALTHY", metrics: { requestCount: 1, p95LatencyMs: 12 } });
  assert.equal(result.data.systemHealth.status, "HEALTHY");
});
