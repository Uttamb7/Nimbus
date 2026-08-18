import test from "node:test";
import assert from "node:assert/strict";
import { Actions } from "../src/actions.js";
import { Operations } from "../src/operations.js";

test("operator actions control faults and preserve audit history", async () => {
  const requests = [];
  const operations = new Operations({ minSamples: 1, consecutiveWindows: 1 });
  operations.observe({ source: "gateway", status: 500, durationMs: 900 });
  const incident = operations.incidents()[0];
  const actions = new Actions(operations, { adminToken: "test", request: async (url, options) => { requests.push({ url, options }); return new Response("{}", { status: 202 }); }, now: () => "2026-08-18T12:00:00.000Z" });

  await actions.injectFailure({ service: "order-orchestrator", status: 503, latencyMs: 900, durationSeconds: 30 }, "Uttamb7");
  await actions.restoreService({ service: "order-orchestrator" }, "Uttamb7");
  await actions.generateTraffic({ count: 2 }, "Uttamb7");
  actions.acknowledgeIncident({ id: incident.id }, "Uttamb7");
  actions.resolveIncident({ id: incident.id }, "Uttamb7");

  assert.equal(requests.length, 4);
  assert.equal(operations.incidents()[0].status, "RESOLVED");
  assert.deepEqual(actions.auditLog().map((event) => event.action), ["incident.resolved", "incident.acknowledged", "traffic.generated", "failure.restored", "failure.injected"]);
});
