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

test("recovery resolution publishes the incident and audit together", async () => {
  const history = new History();
  const incidents = history.events.subscribe("incidentChanged");
  const audits = history.events.subscribe("auditEventAdded");
  await incidents.next();
  await audits.next();
  await history.createIncident({ id: "incident", severity: "SEV2", status: "OPEN", title: "gateway is unhealthy", suspectedService: "gateway", triggerCondition: "error rate", createdAt: "2026-09-04T12:00:00.000Z", acknowledgedAt: null, resolvedAt: null });
  await incidents.next();

  const result = await history.resolveRecoveredIncident("gateway", { id: "audit", timestamp: "2026-09-04T12:01:00.000Z", actor: "nimbus-system", action: "incident.resolved", resource: "incident", metadata: '{"reason":"measured recovery"}' });
  assert.equal(result.incident.status, "RESOLVED");
  assert.equal((await incidents.next()).value.incidentChanged.status, "RESOLVED");
  assert.equal((await audits.next()).value.auditEventAdded.resourceId, "incident");
  assert.equal(await history.resolveRecoveredIncident("gateway", { id: "duplicate" }), null);
  assert.equal((await history.auditLog()).length, 1);
  await incidents.return();
  await audits.return();
});

test("failed recovery transaction publishes no incident or audit", async () => {
  let rolledBack = false;
  const client = {
    query: async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "ROLLBACK") { rolledBack = true; return { rows: [] }; }
      if (sql.startsWith("SELECT id")) return { rows: [{ id: "incident" }] };
      if (sql.startsWith("UPDATE incidents")) return { rows: [{ id: "incident", severity: "SEV2", status: "RESOLVED", title: "Failure", suspected_service: "gateway", trigger_condition: "error rate", created_at: "2026-09-04T12:00:00.000Z", resolved_at: "2026-09-04T12:01:00.000Z" }] };
      throw new Error("audit unavailable");
    },
    release() {},
  };
  const history = new History({ pool: { connect: async () => client } });
  const incidents = history.events.subscribe("incidentChanged");
  const audits = history.events.subscribe("auditEventAdded");
  await incidents.next();
  await audits.next();
  const nextIncident = incidents.next();
  const nextAudit = audits.next();

  await assert.rejects(
    history.resolveRecoveredIncident("gateway", { id: "audit", timestamp: "2026-09-04T12:01:00.000Z", actor: "nimbus-system", action: "incident.resolved", resource: "incident", metadata: "{}" }),
    /audit unavailable/,
  );
  assert.equal(rolledBack, true);
  await incidents.return();
  await audits.return();
  assert.equal((await nextIncident).done, true);
  assert.equal((await nextAudit).done, true);
});
