export class Topology {
  #edges = new Map();

  constructor({ maxAgeMs = 5 * 60_000, now = () => Date.now(), allowedServices } = {}) {
    Object.assign(this, { maxAgeMs, now, allowedServices });
  }

  #prune() {
    for (const [key, edge] of this.#edges) {
      if (this.now() - Date.parse(edge.lastObserved) > this.maxAgeMs) this.#edges.delete(key);
    }
  }

  observe({ source, destination, protocol = "HTTP", status, durationMs }) {
    const validStatus = status === 0 || (Number.isInteger(status) && status >= 100 && status <= 599);
    if (
      typeof source !== "string" || !source ||
      typeof destination !== "string" || !destination ||
      protocol !== "HTTP" || !validStatus ||
      !Number.isFinite(durationMs) || durationMs < 0 ||
      (this.allowedServices && (!this.allowedServices.has(source) || !this.allowedServices.has(destination)))
    ) throw new Error("invalid observation");
    this.#prune();
    const key = `${source}->${destination}`;
    const edge = this.#edges.get(key) || { source, destination, protocol, requestCount: 0, errorCount: 0, totalLatencyMs: 0 };
    edge.requestCount++;
    edge.errorCount += status === 0 || status >= 500 ? 1 : 0;
    edge.totalLatencyMs += durationMs;
    edge.lastObserved = new Date(this.now()).toISOString();
    this.#edges.set(key, edge);
    return this.edge(key);
  }

  edge(key) {
    this.#prune();
    const edge = this.#edges.get(key);
    return edge && { ...edge, averageLatencyMs: edge.totalLatencyMs / edge.requestCount };
  }

  edges() {
    this.#prune();
    return [...this.#edges.keys()].map((key) => this.edge(key));
  }

  shortestPath(source, destination) {
    const queue = [[source]];
    const seen = new Set([source]);
    while (queue.length) {
      const path = queue.shift();
      const node = path.at(-1);
      if (node === destination) return path;
      for (const edge of this.edges().filter((candidate) => candidate.source === node)) {
        if (!seen.has(edge.destination)) {
          seen.add(edge.destination);
          queue.push([...path, edge.destination]);
        }
      }
    }
    return [];
  }

  downstream(source) {
    const queue = [source];
    const seen = new Set([source]);
    while (queue.length) {
      const node = queue.shift();
      for (const edge of this.edges().filter((candidate) => candidate.source === node)) {
        if (!seen.has(edge.destination)) {
          seen.add(edge.destination);
          queue.push(edge.destination);
        }
      }
    }
    seen.delete(source);
    return [...seen];
  }
}
