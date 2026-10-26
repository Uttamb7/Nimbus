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

test("dependency reports send the configured telemetry credential", async (t) => {
  process.env.SERVICE_NAME = "gateway";
  process.env.TELEMETRY_URL = "http://control-plane:4000/observe";
  process.env.TELEMETRY_TOKEN = "telemetry-test";
  t.after(() => {
    delete process.env.TELEMETRY_URL;
    delete process.env.TELEMETRY_TOKEN;
  });
  const reports = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === process.env.TELEMETRY_URL) reports.push(options);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  t.mock.method(console, "log", () => {});

  await request("http://inventory-api/reserve");

  assert.equal(reports.length, 1);
  assert.equal(reports[0].headers.authorization, "Bearer telemetry-test");
});
