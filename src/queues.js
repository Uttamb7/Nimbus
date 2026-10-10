const knownQueues = new Set([
  "nimbus.payment-worker",
  "nimbus.notification-router",
  "nimbus.analytics-ingestor",
  "nimbus.dead-letter",
]);

export class Queues {
  constructor({ baseUrl, username, password, request = fetch } = {}) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.request = request;
  }

  async list() {
    if (!this.baseUrl || !this.username || !this.password) {
      throw new Error("queue backend is not configured");
    }
    let response;
    try {
      response = await this.request(new URL("/api/queues/%2F", this.baseUrl), {
        headers: { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      throw new Error("queue backend unavailable: " + error.message);
    }
    if (!response.ok) throw new Error("queue backend returned " + response.status);

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("queue backend returned malformed data");
    }
    if (!Array.isArray(result)) throw new Error("queue backend returned malformed data");
    const queues = result.filter((queue) => knownQueues.has(queue?.name)).map((queue) => {
      const counts = [queue.messages_ready, queue.messages_unacknowledged, queue.consumers];
      if (counts.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error("queue backend returned malformed data");
      }
      return {
        name: queue.name,
        ready: queue.messages_ready,
        unacknowledged: queue.messages_unacknowledged,
        consumers: queue.consumers,
      };
    });
    if (new Set(queues.map((queue) => queue.name)).size !== queues.length) {
      throw new Error("queue backend returned malformed data");
    }
    return queues.sort((a, b) => a.name.localeCompare(b.name));
  }
}
