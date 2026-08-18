export class Topology {
  #edges = new Map();

  observe({ source, destination, protocol = "HTTP", status, durationMs }) {
    if (!source || !destination || !Number.isFinite(status) || !Number.isFinite(durationMs)) throw new Error("invalid observation");
    const key = `${source}->${destination}`;
    const edge = this.#edges.get(key) || { source, destination, protocol, requestCount: 0, errorCount: 0, totalLatencyMs: 0 };
    edge.requestCount++;
    edge.errorCount += status === 0 || status >= 500 ? 1 : 0;
    edge.totalLatencyMs += durationMs;
    edge.lastObserved = new Date().toISOString();
    this.#edges.set(key, edge);
    return this.edge(key);
  }

  edge(key) {
    const edge = this.#edges.get(key);
    return edge && { ...edge, averageLatencyMs: edge.totalLatencyMs / edge.requestCount };
  }

  edges() {
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
