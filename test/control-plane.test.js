import test from "node:test";
import assert from "node:assert/strict";
import { maxJsonBodyBytes } from "../src/http.js";

process.env.SERVICE_NAME = "control-plane";
process.env.TELEMETRY_TOKEN = "telemetry-test";
process.env.AUTH_TOKENS = "viewer-test:viewer:Test Viewer";
const { history, operations, start, topology } = await import("../src/control-plane.js");

test("control plane rejects oversized JSON before changing operational state", async (t) => {
  let historyCloses = 0;
  let readinessError;
  t.mock.method(history, "close", async () => { historyCloses += 1; });
  t.mock.method(history, "ready", async () => {
    if (readinessError) throw readinessError;
    return true;
  });
  const server = await start(0);
  t.after(() => { if (server.listening) server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { service: "control-plane", status: "ready" });

  readinessError = new Error("secret database address");
  const unavailable = await fetch(`${baseUrl}/ready`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    service: "control-plane", status: "unavailable",
  });
  const live = await fetch(`${baseUrl}/health`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { service: "control-plane", status: "healthy" });

  const oversizedObservation = JSON.stringify({
    source: "gateway", destination: "identity-api", status: 200, durationMs: 1,
    padding: "x".repeat(maxJsonBodyBytes),
  });

  for (const contentType of [undefined, "text/plain"]) {
    const headers = { authorization: "Bearer telemetry-test" };
    if (contentType) headers["content-type"] = contentType;
    const response = await fetch(`${baseUrl}/observe`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(response.status, 415);
  }
  assert.deepEqual(topology.edges(), []);
  assert.equal(operations.metrics("gateway").requestCount, 0);
  assert.deepEqual(await operations.incidents(), []);

  const malformedObservation = await fetch(`${baseUrl}/observe`, {
    method: "POST",
    headers: { authorization: "Bearer telemetry-test", "content-type": "application/json" },
    body: '{"source":',
  });
  assert.equal(malformedObservation.status, 400);
  assert.deepEqual(topology.edges(), []);
  assert.equal(operations.metrics("gateway").requestCount, 0);

  const wrongGraphqlType = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-test", "content-type": "application/graphql" },
    body: "{ services { name } }",
  });
  assert.equal(wrongGraphqlType.status, 415);

  const malformedGraphql = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-test", "content-type": "application/json" },
    body: '{"query":',
  });
  assert.equal(malformedGraphql.status, 400);

  const observationResponse = await fetch(`${baseUrl}/observe`, {
    method: "POST",
    headers: { authorization: "Bearer telemetry-test", "content-type": "application/json" },
    body: oversizedObservation,
  });
  assert.equal(observationResponse.status, 413);
  assert.deepEqual(topology.edges(), []);
  assert.equal(operations.metrics("gateway").requestCount, 0);
  assert.deepEqual(await operations.incidents(), []);

  const graphqlResponse = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-test", "content-type": "application/json" },
    body: JSON.stringify({ query: "{ services { name } }", padding: "x".repeat(maxJsonBodyBytes) }),
  });
  assert.equal(graphqlResponse.status, 413);

  const validResponse = await fetch(`${baseUrl}/observe`, {
    method: "POST",
    headers: { authorization: "Bearer telemetry-test", "content-type": "Application/JSON; charset=utf-8" },
    body: JSON.stringify({ source: "gateway", destination: "identity-api", status: 200, durationMs: 1 }),
  });
  assert.equal(validResponse.status, 202);
  assert.equal(topology.edges().length, 1);
  assert.equal(operations.metrics("gateway").requestCount, 1);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyCloses, 1);
});
