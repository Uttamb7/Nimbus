const services = new Set(["gateway", "identity-api", "inventory-api", "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor"]);

const tag = (span, key) => span.tags?.find((value) => value.key === key)?.value;
const timestamp = (microseconds) => {
  const value = new Date(microseconds / 1_000);
  if (!Number.isFinite(value.getTime())) throw new Error("trace backend returned malformed data");
  return value.toISOString();
};

export class Traces {
  constructor({ baseUrl, request = fetch } = {}) {
    this.baseUrl = baseUrl;
    this.request = request;
  }

  async recent({ service, limit = 5 }) {
    if (!services.has(service)) throw new Error("unknown service");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("trace limit must be 1-20");
    if (!this.baseUrl) throw new Error("trace backend is not configured");

    const url = new URL("/api/traces", this.baseUrl);
    url.searchParams.set("service", service);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("lookback", "1h");
    let response;
    try {
      response = await this.request(url);
    } catch (error) {
      throw new Error("trace backend unavailable: " + error.message);
    }
    if (!response.ok) throw new Error("trace backend returned " + response.status);

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("trace backend returned malformed data");
    }
    if (!Array.isArray(result?.data)) throw new Error("trace backend returned malformed data");
    return result.data.map((trace) => this.#map(trace)).sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  #map(trace) {
    if (typeof trace?.traceID !== "string" || !Array.isArray(trace.spans) || !trace.processes || !trace.spans.length) {
      throw new Error("trace backend returned malformed data");
    }
    const spans = trace.spans.map((span) => {
      const process = trace.processes[span.processID];
      if (typeof span.spanID !== "string" || typeof span.operationName !== "string" ||
          !Number.isFinite(span.startTime) || !Number.isFinite(span.duration) || span.duration < 0 ||
          typeof process?.serviceName !== "string") {
        throw new Error("trace backend returned malformed data");
      }
      const parent = span.references?.find((reference) => reference.refType === "CHILD_OF")?.spanID || null;
      const status = Number(tag(span, "http.response.status_code") ?? tag(span, "http.status_code"));
      return {
        spanId: span.spanID,
        parentSpanId: parent,
        service: process.serviceName,
        operation: span.operationName,
        startTime: timestamp(span.startTime),
        durationMs: span.duration / 1_000,
        error: tag(span, "error") === true || tag(span, "otel.status_code") === "ERROR" || status >= 500,
      };
    });
    const start = Math.min(...trace.spans.map((span) => span.startTime));
    const end = Math.max(...trace.spans.map((span) => span.startTime + span.duration));
    return {
      traceId: trace.traceID,
      startTime: timestamp(start),
      durationMs: (end - start) / 1_000,
      services: [...new Set(spans.map((span) => span.service))].sort(),
      spans: spans.sort((a, b) => a.startTime.localeCompare(b.startTime)),
    };
  }
}
