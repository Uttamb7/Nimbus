import test from "node:test";
import assert from "node:assert/strict";

test("health stays available during an injected fault", async () => {
  process.env.SERVICE_NAME = "identity-api";
  process.env.NODE_ENV = "test";
  process.env.FAULT_STATUS = "503";
  const { start } = await import("../src/server.js");
  const server = await start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await response.json(), { service: "identity-api", status: "healthy" });
  const fault = await fetch(`http://127.0.0.1:${port}/users/me`);
  assert.equal(fault.status, 503);
  assert.deepEqual(await fault.json(), { error: "injected fault" });
  await new Promise((resolve) => server.close(resolve));
});
