import pg from "pg";
import { migrate } from "./migrations.js";
import { LiveEvents } from "./live-events.js";

const { Pool } = pg;

const iso = (value) => value ? new Date(value).toISOString() : null;
const incidentFromRow = (row) => ({
  id: row.id,
  severity: row.severity,
  status: row.status,
  title: row.title,
  suspectedService: row.suspected_service,
  triggerCondition: row.trigger_condition,
  createdAt: iso(row.created_at),
  acknowledgedAt: iso(row.acknowledged_at),
  resolvedAt: iso(row.resolved_at),
});
const auditFromRow = (row) => ({
  id: row.id,
  timestamp: iso(row.recorded_at),
  actor: row.actor,
  action: row.action,
  resource: row.resource,
  resourceId: row.resource_id,
  metadata: JSON.stringify(row.metadata),
});

export class History {
  #incidents = [];
  #audit = [];

  constructor({ connectionString, pool } = {}) {
    this.pool = pool || (connectionString ? new Pool({ connectionString }) : null);
    this.events = new LiveEvents();
  }

  migrate(directory) {
    return migrate(this.pool, directory);
  }

  async createIncident(incident) {
    if (!this.pool) {
      if (this.#incidents.some((value) => value.suspectedService === incident.suspectedService && value.status !== "RESOLVED")) return null;
      this.#incidents.unshift({ ...incident });
      this.events.publish("incidentChanged", { ...incident });
      return { ...incident };
    }
    const result = await this.pool.query(
      `INSERT INTO incidents (id, severity, status, title, suspected_service, trigger_condition, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [incident.id, incident.severity, incident.status, incident.title, incident.suspectedService, incident.triggerCondition, incident.createdAt],
    );
    const created = result.rows[0] ? incidentFromRow(result.rows[0]) : null;
    if (created) this.events.publish("incidentChanged", created);
    return created;
  }

  async incidents() {
    if (!this.pool) return this.#incidents.map((incident) => ({ ...incident }));
    const result = await this.pool.query("SELECT * FROM incidents ORDER BY created_at DESC");
    return result.rows.map(incidentFromRow);
  }

  async incident(id) {
    if (!this.pool) {
      const incident = this.#incidents.find((value) => value.id === id);
      return incident ? { ...incident } : null;
    }
    const result = await this.pool.query("SELECT * FROM incidents WHERE id = $1", [id]);
    return result.rows[0] ? incidentFromRow(result.rows[0]) : null;
  }

  async updateIncident(id, status, timestamp) {
    if (!this.pool) {
      const incident = this.#incidents.find((value) => value.id === id);
      if (!incident || incident.status === "RESOLVED") return null;
      incident.status = status;
      if (status === "ACKNOWLEDGED") incident.acknowledgedAt ||= timestamp;
      if (status === "RESOLVED") incident.resolvedAt = timestamp;
      this.events.publish("incidentChanged", { ...incident });
      return { ...incident };
    }
    const field = status === "ACKNOWLEDGED" ? "acknowledged_at" : "resolved_at";
    const result = await this.pool.query(
      `UPDATE incidents SET status = $2, ${field} = COALESCE(${field}, $3) WHERE id = $1 AND status <> 'RESOLVED' RETURNING *`,
      [id, status, timestamp],
    );
    const updated = result.rows[0] ? incidentFromRow(result.rows[0]) : null;
    if (updated) this.events.publish("incidentChanged", updated);
    return updated;
  }

  async resolveRecoveredIncident(service, event) {
    if (!this.pool) {
      const incident = this.#incidents.find((value) => value.suspectedService === service && value.status !== "RESOLVED");
      if (!incident) return null;
      incident.status = "RESOLVED";
      incident.resolvedAt = event.timestamp;
      const audit = Object.freeze({ ...event, resourceId: incident.id });
      this.#audit.unshift(audit);
      this.events.publish("incidentChanged", { ...incident });
      this.events.publish("auditEventAdded", { ...audit });
      return { incident: { ...incident }, audit };
    }
    const client = await this.pool.connect();
    let incident;
    let audit;
    try {
      await client.query("BEGIN");
      const active = await client.query(
        "SELECT id FROM incidents WHERE suspected_service = $1 AND status <> 'RESOLVED' FOR UPDATE",
        [service],
      );
      if (!active.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const updated = await client.query(
        "UPDATE incidents SET status = 'RESOLVED', resolved_at = $2 WHERE id = $1 RETURNING *",
        [active.rows[0].id, event.timestamp],
      );
      incident = incidentFromRow(updated.rows[0]);
      const recorded = await client.query(
        `INSERT INTO audit_events (id, recorded_at, actor, action, resource, resource_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
        [event.id, event.timestamp, event.actor, event.action, event.resource, incident.id, event.metadata],
      );
      audit = auditFromRow(recorded.rows[0]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.events.publish("incidentChanged", incident);
    this.events.publish("auditEventAdded", audit);
    return { incident, audit };
  }

  async appendAudit(event) {
    if (!this.pool) {
      this.#audit.unshift(event);
      this.events.publish("auditEventAdded", { ...event });
      return { ...event };
    }
    const result = await this.pool.query(
      `INSERT INTO audit_events (id, recorded_at, actor, action, resource, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [event.id, event.timestamp, event.actor, event.action, event.resource, event.resourceId, event.metadata],
    );
    const recorded = auditFromRow(result.rows[0]);
    this.events.publish("auditEventAdded", recorded);
    return recorded;
  }

  async auditLog() {
    if (!this.pool) return this.#audit.map((event) => ({ ...event }));
    const result = await this.pool.query("SELECT * FROM audit_events ORDER BY recorded_at DESC");
    return result.rows.map(auditFromRow);
  }
}
