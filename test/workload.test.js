import test from "node:test";
import assert from "node:assert/strict";

test("health reports the running service", async () => {
  process.env.SERVICE_NAME = "identity-api";
  process.env.NODE_ENV = "test";
  const { start } = await import("../src/server.js");
  const server = await start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await response.json(), { service: "identity-api", status: "healthy" });
  await new Promise((resolve) => server.close(resolve));
});
