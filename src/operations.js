import { randomUUID } from "node:crypto";

const percentile = (values, fraction) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : 0;

export class Operations {
  #samples = new Map();
  #violations = new Map();
  #incidents = [];

  constructor({ availabilityTarget = 0.999, p95LimitMs = 800, errorRateLimit = 0.05, minSamples = 5, consecutiveWindows = 3, now = () => Date.now() } = {}) {
    Object.assign(this, { availabilityTarget, p95LimitMs, errorRateLimit, minSamples, consecutiveWindows, now });
  }

  observe(observation) {
    const samples = this.#samples.get(observation.source) || [];
    samples.push({ status: observation.status, durationMs: observation.durationMs, at: this.now() });
    if (samples.length > 100) samples.shift();
    this.#samples.set(observation.source, samples);

    const metrics = this.metrics(observation.source);
    const violated = metrics.requestCount >= this.minSamples && (metrics.p95LatencyMs > this.p95LimitMs || metrics.errorRate > this.errorRateLimit);
    const count = violated ? (this.#violations.get(observation.source) || 0) + 1 : 0;
    this.#violations.set(observation.source, count);
    if (count >= this.consecutiveWindows && !this.#incidents.some((incident) => incident.suspectedService === observation.source && incident.status !== "RESOLVED")) {
      const reason = metrics.p95LatencyMs > this.p95LimitMs ? `p95 latency exceeded ${this.p95LimitMs} ms` : `error rate exceeded ${this.errorRateLimit * 100}%`;
      const incident = { id: randomUUID(), severity: "SEV2", status: "OPEN", title: `${observation.source} is unhealthy`, suspectedService: observation.source, triggerCondition: reason, createdAt: new Date(this.now()).toISOString(), acknowledgedAt: null, resolvedAt: null };
      this.#incidents.unshift(incident);
      return incident;
    }
  }

  metrics(service) {
    const samples = this.#samples.get(service) || [];
    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
    const availability = samples.length ? 1 - errors / samples.length : 0;
    const elapsedSeconds = samples.length > 1 ? Math.max(1, (this.now() - samples[0].at) / 1000) : 1;
    const errorRate = samples.length ? errors / samples.length : 0;
    const p95LatencyMs = percentile(durations, 0.95);
    const health = !samples.length ? "UNKNOWN" : samples.length >= this.minSamples && (errorRate > this.errorRateLimit || p95LatencyMs > this.p95LimitMs) ? "CRITICAL" : errorRate > 0 || p95LatencyMs > this.p95LimitMs * 0.75 ? "DEGRADED" : "HEALTHY";
    const budget = 1 - this.availabilityTarget;
    return { requestCount: samples.length, requestRate: samples.length / elapsedSeconds, errorRate, p50LatencyMs: percentile(durations, 0.5), p95LatencyMs, p99LatencyMs: percentile(durations, 0.99), availability, sloCompliance: availability >= this.availabilityTarget, errorBudgetRemaining: samples.length ? Math.max(0, 1 - (1 - availability) / budget) : 0, health };
  }

  incidents() {
    return this.#incidents.map((incident) => ({ ...incident }));
  }
}
