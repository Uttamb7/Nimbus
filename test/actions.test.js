import test from "node:test";
import assert from "node:assert/strict";
import { Actions } from "../src/actions.js";
import { Operations } from "../src/operations.js";

test("operator actions control faults and preserve audit history", async () => {
  const requests = [];
  const operations = new Operations({ minSamples: 1, consecutiveWindows: 1 });
  await operations.observe({ source: "gateway", status: 500, durationMs: 900 });
  const incident = (await operations.incidents())[0];
  const actions = new Actions(operations, { adminToken: "test", request: async (url, options) => { requests.push({ url, options }); return new Response("{}", { status: 202 }); }, now: () => "2026-08-18T12:00:00.000Z" });

  await actions.injectFailure({ service: "order-orchestrator", status: 503, latencyMs: 900, durationSeconds: 30 }, "Uttamb7");
  await actions.restoreService({ service: "order-orchestrator" }, "Uttamb7");
  await actions.generateTraffic({ count: 2 }, "Uttamb7");
  await actions.acknowledgeIncident({ id: incident.id }, "Uttamb7");
  await actions.resolveIncident({ id: incident.id }, "Uttamb7");

  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
  assert.equal((await operations.incidents())[0].status, "RESOLVED");
  assert.deepEqual((await actions.auditLog()).map((event) => event.action), ["incident.resolved", "incident.acknowledged", "traffic.generated", "failure.restored", "failure.injected"]);
});

test("operator action requests time out without false success audits", async () => {
  const requests = [];
  const operations = new Operations();
  const request = (url, options) => {
    requests.push({ url, options });
    return new Promise((resolve, reject) => {
      const pending = setTimeout(resolve, 1_000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(pending);
        reject(options.signal.reason);
      }, { once: true });
    });
  };
  const actions = new Actions(operations, { request, requestTimeoutMs: 5 });

  await assert.rejects(
    actions.injectFailure({ service: "gateway" }, "Uttamb7"),
    { name: "TimeoutError" },
  );
  await assert.rejects(
    actions.restoreService({ service: "gateway" }, "Uttamb7"),
    { name: "TimeoutError" },
  );
  assert.deepEqual(await actions.auditLog(), []);

  const traffic = await actions.generateTraffic({ count: 2 }, "Uttamb7");
  assert.deepEqual(JSON.parse(traffic.metadata), { count: 2, succeeded: 0 });
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
});
