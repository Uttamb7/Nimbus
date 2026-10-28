import test from "node:test";
import assert from "node:assert/strict";
import { maxJsonBodyBytes } from "../src/http.js";

process.env.SERVICE_NAME = "control-plane";
process.env.TELEMETRY_TOKEN = "telemetry-test";
process.env.AUTH_TOKENS = "viewer-test:viewer:Test Viewer";
const { operations, start, topology } = await import("../src/control-plane.js");

test("control plane rejects oversized JSON before changing operational state", async (t) => {
  const server = await start(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const oversizedObservation = JSON.stringify({
    source: "gateway", destination: "identity-api", status: 200, durationMs: 1,
    padding: "x".repeat(maxJsonBodyBytes),
  });

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
    headers: { authorization: "Bearer telemetry-test", "content-type": "application/json" },
    body: JSON.stringify({ source: "gateway", destination: "identity-api", status: 200, durationMs: 1 }),
  });
  assert.equal(validResponse.status, 202);
  assert.equal(topology.edges().length, 1);
  assert.equal(operations.metrics("gateway").requestCount, 1);
});
