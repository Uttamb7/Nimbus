import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../src/history.js";

test("history preserves incident lifecycle and append-only audit records", async () => {
  const history = new History();
  const incident = { id: "9c86d62c-aedd-4f65-9107-7de20b19d98a", severity: "SEV2", status: "OPEN", title: "gateway is unhealthy", suspectedService: "gateway", triggerCondition: "error rate", createdAt: "2026-08-19T12:00:00.000Z", acknowledgedAt: null, resolvedAt: null };
  const event = Object.freeze({ id: "9a820ef4-bf51-4dfa-854f-9ae7ff95a1e4", timestamp: "2026-08-19T12:01:00.000Z", actor: "Uttamb7", action: "incident.acknowledged", resource: "incident", resourceId: incident.id, metadata: "{}" });

  await history.createIncident(incident);
  await history.updateIncident(incident.id, "ACKNOWLEDGED", event.timestamp);
  await history.appendAudit(event);

  assert.equal((await history.incident(incident.id)).status, "ACKNOWLEDGED");
  assert.deepEqual(await history.auditLog(), [event]);
  assert.equal(await history.createIncident({ ...incident, id: "ae5cc18f-8fa1-42d9-9c53-5ac7da820983" }), null);
});
