import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { body, maxJsonBodyBytes, request } from "../src/http.js";
import { Topology } from "../src/topology.js";

const incoming = (chunks, headers = {}) => Object.assign(Readable.from(chunks), { headers });

test("JSON bodies enforce their declared and streamed size", async () => {
  const valid = JSON.stringify({ value: "x".repeat(maxJsonBodyBytes - 12) });
  const jsonHeaders = { "content-type": "Application/JSON; charset=utf-8" };
  assert.deepEqual(await body(incoming([Buffer.from(valid)], { ...jsonHeaders, "content-length": Buffer.byteLength(valid) }), { requireJson: true }), JSON.parse(valid));

  for (const contentType of [undefined, "text/plain", "application/graphql"]) {
    await assert.rejects(
      body(incoming([Buffer.from("{}")], contentType ? { "content-type": contentType } : {}), { requireJson: true }),
      (error) => error.statusCode === 415 && /application\/json/.test(error.message),
    );
  }

  await assert.rejects(
    body(incoming([], { ...jsonHeaders, "content-length": maxJsonBodyBytes + 1 }), { requireJson: true }),
    (error) => error.statusCode === 413 && /exceeds/.test(error.message),
  );
  await assert.rejects(
    body(incoming([Buffer.alloc(maxJsonBodyBytes), Buffer.alloc(1)], jsonHeaders), { requireJson: true }),
    (error) => error.statusCode === 413 && /exceeds/.test(error.message),
  );
});

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
