import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

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
  }

  async migrate(directory = join(process.cwd(), "migrations")) {
    if (!this.pool) return;
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('nimbus-schema-migrations'))");
        const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
        if (!applied.rowCount) {
          await client.query(await readFile(join(directory, file), "utf8"));
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async createIncident(incident) {
    if (!this.pool) {
      if (this.#incidents.some((value) => value.suspectedService === incident.suspectedService && value.status !== "RESOLVED")) return null;
      this.#incidents.unshift({ ...incident });
      return { ...incident };
    }
    const result = await this.pool.query(
      `INSERT INTO incidents (id, severity, status, title, suspected_service, trigger_condition, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [incident.id, incident.severity, incident.status, incident.title, incident.suspectedService, incident.triggerCondition, incident.createdAt],
    );
    return result.rows[0] ? incidentFromRow(result.rows[0]) : null;
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
      return { ...incident };
    }
    const field = status === "ACKNOWLEDGED" ? "acknowledged_at" : "resolved_at";
    const result = await this.pool.query(
      `UPDATE incidents SET status = $2, ${field} = COALESCE(${field}, $3) WHERE id = $1 AND status <> 'RESOLVED' RETURNING *`,
      [id, status, timestamp],
    );
    return result.rows[0] ? incidentFromRow(result.rows[0]) : null;
  }

  async appendAudit(event) {
    if (!this.pool) {
      this.#audit.unshift(event);
      return { ...event };
    }
    const result = await this.pool.query(
      `INSERT INTO audit_events (id, recorded_at, actor, action, resource, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [event.id, event.timestamp, event.actor, event.action, event.resource, event.resourceId, event.metadata],
    );
    return auditFromRow(result.rows[0]);
  }

  async auditLog() {
    if (!this.pool) return this.#audit.map((event) => ({ ...event }));
    const result = await this.pool.query("SELECT * FROM audit_events ORDER BY recorded_at DESC");
    return result.rows.map(auditFromRow);
  }
}
