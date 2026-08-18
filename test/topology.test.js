import test from "node:test";
import assert from "node:assert/strict";
import { Topology } from "../src/topology.js";

test("topology aggregates observations and finds paths", () => {
  const topology = new Topology();
  topology.observe({ source: "gateway", destination: "orders", status: 200, durationMs: 10 });
  topology.observe({ source: "gateway", destination: "orders", status: 500, durationMs: 30 });
  topology.observe({ source: "orders", destination: "inventory", status: 200, durationMs: 5 });
  assert.deepEqual(topology.shortestPath("gateway", "inventory"), ["gateway", "orders", "inventory"]);
  assert.equal(topology.edges()[0].requestCount, 2);
  assert.equal(topology.edges()[0].errorCount, 1);
  assert.equal(topology.edges()[0].averageLatencyMs, 20);
  assert.deepEqual(topology.downstream("gateway"), ["orders", "inventory"]);
});
