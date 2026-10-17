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

test("topology expires stale edges from graphs, paths, and blast radius", () => {
  let now = Date.parse("2026-10-17T12:00:00.000Z");
  const topology = new Topology({ maxAgeMs: 300_000, now: () => now });
  topology.observe({ source: "gateway", destination: "orders", status: 500, durationMs: 30 });
  now += 300_000;
  topology.observe({ source: "orders", destination: "inventory", status: 200, durationMs: 5 });

  assert.equal(topology.edges().length, 2);
  assert.deepEqual(topology.shortestPath("gateway", "inventory"), ["gateway", "orders", "inventory"]);
  assert.deepEqual(topology.downstream("gateway"), ["orders", "inventory"]);

  now += 1;
  assert.deepEqual(topology.edges().map(({ source, destination }) => [source, destination]), [["orders", "inventory"]]);
  assert.deepEqual(topology.shortestPath("gateway", "inventory"), []);
  assert.deepEqual(topology.downstream("gateway"), []);

  topology.observe({ source: "gateway", destination: "orders", status: 200, durationMs: 10 });
  assert.deepEqual(
    { requestCount: topology.edges()[1].requestCount, errorCount: topology.edges()[1].errorCount },
    { requestCount: 1, errorCount: 0 },
  );
});
