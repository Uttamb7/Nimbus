import test from "node:test";
import assert from "node:assert/strict";
import { graphql } from "graphql";
import { root, schema } from "../src/schema.js";
import { Topology } from "../src/topology.js";

test("GraphQL exposes observed edges", async () => {
  const topology = new Topology();
  topology.observe({ source: "gateway", destination: "identity-api", status: 200, durationMs: 12 });
  const result = await graphql({ schema, source: "{ serviceGraph { source destination requestCount averageLatencyMs } }", rootValue: root(topology) });
  assert.deepEqual({ ...result.data.serviceGraph[0] }, { source: "gateway", destination: "identity-api", requestCount: 1, averageLatencyMs: 12 });
});
