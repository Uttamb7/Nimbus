import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { body, createHttpServer, httpServerLimits, maxJsonBodyBytes, request } from "../src/http.js";
import { Topology } from "../src/topology.js";

test("HTTP servers bound time and concurrent connections", () => {
  const server = createHttpServer(() => {});
  assert.equal(server.headersTimeout, httpServerLimits.headersTimeout);
  assert.equal(server.requestTimeout, httpServerLimits.requestTimeout);
  assert.equal(server.keepAliveTimeout, httpServerLimits.keepAliveTimeout);
  assert.equal(server.maxConnections, httpServerLimits.maxConnections);
});

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
  await assert.rejects(
    body(incoming([Buffer.from('{"missing":')], jsonHeaders), { requireJson: true }),
    (error) => error.statusCode === 400 && /valid JSON/.test(error.message),
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

test("dependency JSON responses require their media type and enforce their size", async (t) => {
  process.env.SERVICE_NAME = "gateway";
  delete process.env.TELEMETRY_URL;
  t.mock.method(console, "log", () => {});
  let response = new Response('{"ok":true}', { headers: { "content-type": "Application/JSON; charset=utf-8", "content-length": "11" } });
  t.mock.method(globalThis, "fetch", async () => response);

  assert.deepEqual(await request("http://identity-api/users/me"), { ok: true });

  let cancellations = 0;
  for (const contentType of [undefined, "text/plain"]) {
    response = new Response(new ReadableStream({
      pull() {},
      cancel() { cancellations += 1; },
    }), { headers: contentType ? { "content-type": contentType } : {} });
    await assert.rejects(
      request("http://identity-api/users/me"),
      /dependency response must be application\/json/,
    );
  }

  response = new Response(new ReadableStream({
    pull() {},
    cancel() { cancellations += 1; },
  }), { headers: { "content-type": "application/json", "content-length": maxJsonBodyBytes + 1 } });
  await assert.rejects(
    request("http://identity-api/users/me"),
    /dependency response exceeds 65536 bytes/,
  );

  let index = 0;
  const chunks = [new Uint8Array(maxJsonBodyBytes), new Uint8Array(1)];
  response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunks[index++]); },
    cancel() { cancellations += 1; },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(
    request("http://identity-api/users/me"),
    /dependency response exceeds 65536 bytes/,
  );
  assert.equal(cancellations, 4);
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
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  t.mock.method(console, "log", () => {});

  await request("http://inventory-api/reserve");

  assert.equal(reports.length, 1);
  assert.equal(reports[0].headers.authorization, "Bearer telemetry-test");
});
