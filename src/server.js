import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { BrokerConsumer, BrokerPublisher, consumers } from "./broker.js";
import { config } from "./config.js";
import { EventStore } from "./event-store.js";
import { orderCreated, OutboxPublisher } from "./events.js";
import { body, request, send } from "./http.js";
import { annotateTrace, currentTraceContext } from "./tracing.js";

const seenEvents = new Set();
let fault = { status: config.faultStatus, latencyMs: 0, expiresAt: Infinity };

async function processEvent(event, eventStore) {
  annotateTrace({ "nimbus.correlation_id": event.correlationId, "nimbus.idempotency_key": event.idempotencyKey });
  const firstDelivery = eventStore ? await eventStore.recordConsumerEvent(config.name, event.eventId) : !seenEvents.has(event.eventId);
  if (!firstDelivery) return false;
  if (!eventStore) seenEvents.add(event.eventId);
  console.log(JSON.stringify({ type: "event", service: config.name, event_id: event.eventId, correlation_id: event.correlationId }));
  return true;
}

async function route(req, res, eventStore) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const correlationId = req.headers["x-correlation-id"] || randomUUID();
  annotateTrace({ "nimbus.correlation_id": correlationId });
  res.setHeader("x-correlation-id", correlationId);

  if (url.pathname === "/health") return send(res, 200, { service: config.name, status: "healthy" });
  if (url.pathname === "/admin/fault" && config.adminToken && req.headers["x-nimbus-admin"] === config.adminToken && config.demoMode) {
    if (req.method === "DELETE") {
      fault = { status: 0, latencyMs: 0, expiresAt: 0 };
      return send(res, 200, { restored: true });
    }
    if (req.method === "POST") {
      const input = await body(req);
      if (!Number.isInteger(input.status) || input.status < 500 || input.status > 599 || !Number.isInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 5_000 || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 300) return send(res, 400, { error: "invalid fault" });
      fault = { status: input.status, latencyMs: input.latencyMs, expiresAt: Date.now() + input.durationSeconds * 1_000 };
      return send(res, 202, { injected: true, ...fault });
    }
  }
  if (Date.now() >= fault.expiresAt) fault = { status: 0, latencyMs: 0, expiresAt: 0 };
  if (fault.latencyMs) await wait(fault.latencyMs);
  if (fault.status) return send(res, fault.status, { error: "injected fault" });
  if (config.name === "identity-api" && url.pathname === "/users/me") return send(res, 200, { id: "demo-user", active: true });
  if (config.name === "inventory-api" && url.pathname === "/reserve" && req.method === "POST") return send(res, 200, { reservationId: randomUUID() });

  if (config.name === "gateway" && url.pathname === "/checkout" && req.method === "POST") {
    const input = await body(req);
    const idempotencyKey = req.headers["idempotency-key"] || randomUUID();
    annotateTrace({ "nimbus.idempotency_key": idempotencyKey });
    const [user, order] = await Promise.all([
      request(`${config.identityUrl}/users/me`, {}, correlationId),
      request(`${config.orderUrl}/orders`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }, correlationId),
    ]);
    return send(res, 202, { userId: user.id, ...order, correlationId });
  }

  if (config.name === "order-orchestrator" && url.pathname === "/orders" && req.method === "POST") {
    const input = await body(req);
    const idempotencyKey = req.headers["idempotency-key"] || randomUUID();
    annotateTrace({ "nimbus.idempotency_key": idempotencyKey });
    const reservation = await request(`${config.inventoryUrl}/reserve`, { method: "POST", body: JSON.stringify(input) }, correlationId);
    const event = orderCreated({ correlationId, idempotencyKey, orderId: randomUUID(), reservationId: reservation.reservationId, traceContext: currentTraceContext() });
    if (eventStore) await eventStore.createOrder(event);
    return send(res, 202, { orderId: event.orderId, status: "accepted" });
  }

  if (url.pathname === "/events" && req.method === "POST") {
    const event = await body(req);
    const accepted = await processEvent(event, eventStore);
    return send(res, accepted ? 202 : 200, { [accepted ? "accepted" : "duplicate"]: true });
  }

  send(res, 404, { error: "not found" });
}

export async function start(port = config.port, dependencies = {}) {
  let eventStore = dependencies.eventStore;
  let publisher = dependencies.publisher;
  let brokerPublisher = dependencies.brokerPublisher;
  let consumer = dependencies.consumer;
  const ownsStore = config.databaseUrl && !eventStore;
  if (ownsStore) {
    eventStore = new EventStore({ connectionString: config.databaseUrl });
    await eventStore.migrate();
  }
  if (config.name === "order-orchestrator" && eventStore && config.brokerUrl && !publisher) {
    brokerPublisher ||= new BrokerPublisher({ url: config.brokerUrl });
    publisher = new OutboxPublisher({ store: eventStore, publishEvent: (event) => brokerPublisher.publish(event) });
  }
  if (consumers.includes(config.name) && eventStore && config.brokerUrl && !consumer) consumer = new BrokerConsumer({ url: config.brokerUrl, name: config.name, handler: (event) => processEvent(event, eventStore) });

  const server = createServer((req, res) => route(req, res, eventStore).catch((error) => {
    console.error(JSON.stringify({ type: "error", service: config.name, message: error.message }));
    if (!res.headersSent) send(res, 502, { error: "dependency failure", correlationId: req.headers["x-correlation-id"] });
    else res.end();
  }));
  await new Promise((resolve) => server.listen(port, resolve));
  publisher?.start();
  consumer?.start();
  server.on("close", async () => {
    await consumer?.stop();
    await publisher?.stop();
    await brokerPublisher?.close();
    if (ownsStore) await eventStore.close();
  });
  return server;
}
