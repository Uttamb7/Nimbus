import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../src/http.js";
import { Topology } from "../src/topology.js";

test("network failures are observed as dependency errors", async (t) => {
  const observations = [];
  process.env.SERVICE_NAME = "gateway";
  delete process.env.TELEMETRY_URL;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  t.mock.method(console, "log", (message) => observations.push(JSON.parse(message)));

  await assert.rejects(request("http://inventory-api/reserve"), /offline/);
  const topology = new Topology();
  topology.observe(observations[0]);
  assert.equal(topology.edges()[0].errorCount, 1);
});
