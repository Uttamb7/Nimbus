import { randomUUID } from "node:crypto";

const services = new Set(["gateway", "identity-api", "inventory-api", "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor"]);

export class Actions {
  #audit = [];

  constructor(operations, { adminToken = process.env.ADMIN_TOKEN, request = fetch, now = () => new Date().toISOString() } = {}) {
    this.operations = operations;
    this.adminToken = adminToken;
    this.request = request;
    this.now = now;
  }

  record(actor, action, resource, resourceId, metadata = {}) {
    const event = Object.freeze({ id: randomUUID(), timestamp: this.now(), actor, action, resource, resourceId, metadata: JSON.stringify(metadata) });
    this.#audit.unshift(event);
    return event;
  }

  async injectFailure({ service, status = 503, latencyMs = 0, durationSeconds = 60 }, actor) {
    if (!services.has(service)) throw new Error("unknown service");
    const response = await this.request(`http://${service}:8080/admin/fault`, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-admin": this.adminToken }, body: JSON.stringify({ status, latencyMs, durationSeconds }) });
    if (!response.ok) throw new Error(`fault injection returned ${response.status}`);
    return this.record(actor, "failure.injected", "service", service, { status, latencyMs, durationSeconds });
  }

  async restoreService({ service }, actor) {
    if (!services.has(service)) throw new Error("unknown service");
    const response = await this.request(`http://${service}:8080/admin/fault`, { method: "DELETE", headers: { "x-nimbus-admin": this.adminToken } });
    if (!response.ok) throw new Error(`restore returned ${response.status}`);
    return this.record(actor, "failure.restored", "service", service);
  }

  async generateTraffic({ count = 1 }, actor) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("count must be 1-20");
    const requests = Array.from({ length: count }, (_, index) => this.request("http://gateway:8080/checkout", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `demo-${Date.now()}-${index}` }, body: JSON.stringify({ sku: "nimbus-demo", quantity: 1 }) }));
    const results = await Promise.allSettled(requests);
    return this.record(actor, "traffic.generated", "system", "demo", { count, succeeded: results.filter((result) => result.status === "fulfilled" && result.value.ok).length });
  }

  acknowledgeIncident({ id }, actor) {
    this.operations.acknowledge(id);
    return this.record(actor, "incident.acknowledged", "incident", id);
  }

  resolveIncident({ id }, actor) {
    this.operations.resolve(id);
    return this.record(actor, "incident.resolved", "incident", id);
  }

  auditLog() {
    return this.#audit.map((event) => ({ ...event }));
  }
}
