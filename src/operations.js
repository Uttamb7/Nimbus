import { randomUUID } from "node:crypto";
import { History } from "./history.js";

const percentile = (values, fraction) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : 0;
const evidence = ({ requestCount, errorRate, p50LatencyMs, p95LatencyMs, p99LatencyMs, availability }) => ({ requestCount, errorRate, p50LatencyMs, p95LatencyMs, p99LatencyMs, availability });

export class Operations {
  #samples = new Map();
  #violations = new Map();
  #recoveries = new Map();
  #baselines = new Map();
  #queueViolations = new Map();
  #queueRecoveries = new Map();
  #outboxViolations = 0;
  #outboxRecoveries = 0;

  constructor({ availabilityTarget = 0.999, p95LimitMs = 800, errorRateLimit = 0.05, minSamples = 5, consecutiveWindows = 3, recoveryWindows = 3, queueWindows = 3, outboxWindows = 3, outboxDelayMs = 60_000, sampleMaxAgeMs = 5 * 60_000, now = () => Date.now(), history = new History() } = {}) {
    Object.assign(this, { availabilityTarget, p95LimitMs, errorRateLimit, minSamples, consecutiveWindows, recoveryWindows, queueWindows, outboxWindows, outboxDelayMs, sampleMaxAgeMs, now, history });
  }

  async observeQueue(queue, service) {
    const stalled = queue.ready > 0 && queue.consumers === 0;
    const recovered = queue.ready === 0 && queue.consumers > 0;
    const violations = stalled ? (this.#queueViolations.get(queue.name) || 0) + 1 : 0;
    const recoveries = recovered ? (this.#queueRecoveries.get(queue.name) || 0) + 1 : 0;
    this.#queueViolations.set(queue.name, Math.min(violations, this.queueWindows));
    this.#queueRecoveries.set(queue.name, Math.min(recoveries, this.queueWindows));
    const triggerCondition = `${queue.name} has ready messages with no consumers`;

    if (violations >= this.queueWindows) {
      this.#queueRecoveries.set(queue.name, 0);
      return this.history.createIncident({
        id: randomUUID(), severity: "SEV2", status: "OPEN",
        title: `${service} event consumer is stalled`, suspectedService: service,
        affectedServices: [service], triggerCondition,
        evidence: {
          queueReady: queue.ready,
          queueUnacknowledged: queue.unacknowledged,
          queueConsumers: queue.consumers,
        },
        baseline: null, createdAt: new Date(this.now()).toISOString(),
        acknowledgedAt: null, resolvedAt: null,
      });
    }
    if (recoveries >= this.queueWindows) {
      this.#queueRecoveries.set(queue.name, 0);
      const active = (await this.history.incidents()).find((incident) =>
        incident.status !== "RESOLVED" && incident.suspectedService === service && incident.triggerCondition === triggerCondition);
      if (!active) return null;
      const timestamp = new Date(this.now()).toISOString();
      return this.history.resolveRecoveredIncident(service, triggerCondition, Object.freeze({
        id: randomUUID(), timestamp, actor: "nimbus-system", action: "incident.resolved",
        resource: "incident", metadata: JSON.stringify({ reason: "queue consumer recovered", queue: queue.name, consecutiveWindows: this.queueWindows }),
      }));
    }
    return null;
  }

  async observeDeadLetters(queue) {
    const service = "event-delivery";
    const failed = queue.ready > 0;
    const drained = queue.ready === 0 && queue.unacknowledged === 0;
    const violations = failed ? (this.#queueViolations.get(queue.name) || 0) + 1 : 0;
    const recoveries = drained ? (this.#queueRecoveries.get(queue.name) || 0) + 1 : 0;
    this.#queueViolations.set(queue.name, Math.min(violations, this.queueWindows));
    this.#queueRecoveries.set(queue.name, Math.min(recoveries, this.queueWindows));
    const triggerCondition = `${queue.name} contains failed messages`;

    if (violations >= this.queueWindows) {
      this.#queueRecoveries.set(queue.name, 0);
      return this.history.createIncident({
        id: randomUUID(), severity: "SEV2", status: "OPEN",
        title: "order events reached the dead-letter queue", suspectedService: service,
        affectedServices: [service], triggerCondition,
        evidence: {
          queueReady: queue.ready,
          queueUnacknowledged: queue.unacknowledged,
          queueConsumers: queue.consumers,
        },
        baseline: null, createdAt: new Date(this.now()).toISOString(),
        acknowledgedAt: null, resolvedAt: null,
      });
    }
    if (recoveries >= this.queueWindows) {
      this.#queueRecoveries.set(queue.name, 0);
      const active = (await this.history.incidents()).find((incident) =>
        incident.status !== "RESOLVED" && incident.suspectedService === service && incident.triggerCondition === triggerCondition);
      if (!active) return null;
      const timestamp = new Date(this.now()).toISOString();
      return this.history.resolveRecoveredIncident(service, triggerCondition, Object.freeze({
        id: randomUUID(), timestamp, actor: "nimbus-system", action: "incident.resolved",
        resource: "incident", metadata: JSON.stringify({ reason: "dead-letter queue drained", queue: queue.name, consecutiveWindows: this.queueWindows }),
      }));
    }
    return null;
  }

  async observeOutbox(state) {
    const sampledAt = this.now();
    const active = state.pending + state.publishing > 0;
    const oldestUnsentAt = active ? Date.parse(state.oldestUnsentAt) : NaN;
    if (state.deadLetter === 0 && active && !Number.isFinite(oldestUnsentAt)) return null;
    const impaired = state.deadLetter > 0 || (active && sampledAt - oldestUnsentAt >= this.outboxDelayMs);
    this.#outboxViolations = impaired ? Math.min(this.#outboxViolations + 1, this.outboxWindows) : 0;
    this.#outboxRecoveries = impaired ? 0 : Math.min(this.#outboxRecoveries + 1, this.outboxWindows);
    const service = "producer-delivery";
    const triggerCondition = "producer outbox contains dead-letter or delayed events";

    if (this.#outboxViolations >= this.outboxWindows) {
      return this.history.createIncident({
        id: randomUUID(), severity: "SEV2", status: "OPEN",
        title: "order event producer delivery is impaired", suspectedService: service,
        affectedServices: ["order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor"],
        triggerCondition,
        evidence: {
          outboxPending: state.pending,
          outboxPublishing: state.publishing,
          outboxPublished: state.published,
          outboxDeadLetter: state.deadLetter,
          oldestUnsentAt: state.oldestUnsentAt,
        },
        baseline: null, createdAt: new Date(sampledAt).toISOString(),
        acknowledgedAt: null, resolvedAt: null,
      });
    }
    if (this.#outboxRecoveries >= this.outboxWindows) {
      this.#outboxRecoveries = 0;
      const active = (await this.history.incidents()).find((incident) =>
        incident.status !== "RESOLVED" && incident.suspectedService === service && incident.triggerCondition === triggerCondition);
      if (!active) return null;
      const timestamp = new Date(sampledAt).toISOString();
      return this.history.resolveRecoveredIncident(service, triggerCondition, Object.freeze({
        id: randomUUID(), timestamp, actor: "nimbus-system", action: "incident.resolved",
        resource: "incident", metadata: JSON.stringify({ reason: "producer outbox recovered", consecutiveWindows: this.outboxWindows }),
      }));
    }
    return null;
  }

  outboxState() {
    return this.history.outboxState();
  }

  async observe(observation, { affectedServices = [observation.source] } = {}) {
    const samples = this.#samples.get(observation.source) || [];
    samples.push({ status: observation.status, durationMs: observation.durationMs, at: this.now() });
    if (samples.length > 100) samples.shift();
    this.#samples.set(observation.source, samples);

    const metrics = this.metrics(observation.source);
    this.history.events.publish("serviceHealthChanged", { name: observation.source, metrics });
    const violated = metrics.requestCount >= this.minSamples && (metrics.p95LatencyMs > this.p95LimitMs || metrics.errorRate > this.errorRateLimit);
    const metricTriggers = [`p95 latency exceeded ${this.p95LimitMs} ms`, `error rate exceeded ${this.errorRateLimit * 100}%`];
    if (!violated && metrics.requestCount >= this.minSamples) this.#baselines.set(observation.source, evidence(metrics));
    const count = violated ? (this.#violations.get(observation.source) || 0) + 1 : 0;
    this.#violations.set(observation.source, count);
    this.#recoveries.set(observation.source, !violated && metrics.requestCount >= this.minSamples ? (this.#recoveries.get(observation.source) || 0) + 1 : 0);
    if (count >= this.consecutiveWindows) {
      this.#recoveries.set(observation.source, 0);
      const reason = metrics.p95LatencyMs > this.p95LimitMs ? `p95 latency exceeded ${this.p95LimitMs} ms` : `error rate exceeded ${this.errorRateLimit * 100}%`;
      const incident = {
        id: randomUUID(), severity: "SEV2", status: "OPEN",
        title: `${observation.source} is unhealthy`, suspectedService: observation.source,
        affectedServices: [...affectedServices], triggerCondition: reason,
        evidence: evidence(metrics), baseline: this.#baselines.get(observation.source) || null,
        createdAt: new Date(this.now()).toISOString(), acknowledgedAt: null, resolvedAt: null,
      };
      return this.history.createIncident(incident);
    }
    if (this.#recoveries.get(observation.source) >= this.recoveryWindows) {
      this.#recoveries.set(observation.source, 0);
      const active = (await this.history.incidents()).find((incident) =>
        incident.status !== "RESOLVED" && incident.suspectedService === observation.source && metricTriggers.includes(incident.triggerCondition));
      if (!active) return null;
      const timestamp = new Date(this.now()).toISOString();
      return this.history.resolveRecoveredIncident(observation.source, active.triggerCondition, Object.freeze({
        id: randomUUID(), timestamp, actor: "nimbus-system", action: "incident.resolved",
        resource: "incident", metadata: JSON.stringify({ reason: "measured recovery", consecutiveWindows: this.recoveryWindows }),
      }));
    }
  }

  metrics(service) {
    const sampledAt = this.now();
    const stored = this.#samples.get(service) || [];
    const samples = stored.filter((sample) => sampledAt - sample.at <= this.sampleMaxAgeMs);
    if (samples.length !== stored.length) {
      if (samples.length) this.#samples.set(service, samples);
      else this.#samples.delete(service);
      this.#violations.delete(service);
      this.#recoveries.delete(service);
      this.#baselines.delete(service);
    }
    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
    const availability = samples.length ? 1 - errors / samples.length : 0;
    const elapsedSeconds = samples.length > 1 ? Math.max(1, (sampledAt - samples[0].at) / 1000) : 1;
    const errorRate = samples.length ? errors / samples.length : 0;
    const p95LatencyMs = percentile(durations, 0.95);
    const health = !samples.length ? "UNKNOWN" : samples.length >= this.minSamples && (errorRate > this.errorRateLimit || p95LatencyMs > this.p95LimitMs) ? "CRITICAL" : errorRate > 0 || p95LatencyMs > this.p95LimitMs * 0.75 ? "DEGRADED" : "HEALTHY";
    const budget = 1 - this.availabilityTarget;
    return { requestCount: samples.length, requestRate: samples.length / elapsedSeconds, errorRate, p50LatencyMs: percentile(durations, 0.5), p95LatencyMs, p99LatencyMs: percentile(durations, 0.99), availability, sloCompliance: availability >= this.availabilityTarget, errorBudgetRemaining: samples.length ? Math.max(0, 1 - errorRate / budget) : 0, errorBudgetBurnRate: samples.length ? errorRate / budget : 0, health };
  }

  incidents() {
    return this.history.incidents();
  }

  async acknowledge(id) {
    const incident = await this.history.updateIncident(id, "ACKNOWLEDGED", new Date(this.now()).toISOString());
    if (!incident) throw new Error("incident is not active");
    return incident;
  }

  async resolve(id) {
    const incident = await this.history.updateIncident(id, "RESOLVED", new Date(this.now()).toISOString());
    if (!incident) throw new Error("incident is not active");
    return incident;
  }
}

export async function pollOutbox(source, operations) {
  try {
    await operations.observeOutbox(await source.outboxState());
  } catch {
    // A missing database sample is neither a failure nor a recovery signal.
  }
}
