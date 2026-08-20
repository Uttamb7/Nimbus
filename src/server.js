import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { config } from "./config.js";
import { EventStore } from "./event-store.js";
import { deliver, orderCreated, OutboxPublisher } from "./events.js";
import { body, request, send } from "./http.js";

const seenEvents = new Set();
let fault = { status: config.faultStatus, latencyMs: 0, expiresAt: Infinity };

async function route(req, res, eventStore) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const correlationId = req.headers["x-correlation-id"] || randomUUID();
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
    const [user, order] = await Promise.all([
      request(`${config.identityUrl}/users/me`, {}, correlationId),
      request(`${config.orderUrl}/orders`, { method: "POST", body: JSON.stringify(input) }, correlationId),
    ]);
    return send(res, 202, { userId: user.id, ...order, correlationId });
  }

  if (config.name === "order-orchestrator" && url.pathname === "/orders" && req.method === "POST") {
    const input = await body(req);
    const reservation = await request(`${config.inventoryUrl}/reserve`, { method: "POST", body: JSON.stringify(input) }, correlationId);
    const event = orderCreated({ correlationId, idempotencyKey: req.headers["idempotency-key"] || randomUUID(), orderId: randomUUID(), reservationId: reservation.reservationId });
    if (eventStore) await eventStore.createOrder(event);
    else setImmediate(() => Promise.allSettled(config.eventTargets.map((target) => deliver(target, event, correlationId))));
    return send(res, 202, { orderId: event.orderId, status: "accepted" });
  }

  if (url.pathname === "/events" && req.method === "POST") {
    const event = await body(req);
    if (seenEvents.has(event.eventId)) return send(res, 200, { duplicate: true });
    seenEvents.add(event.eventId);
    console.log(JSON.stringify({ type: "event", service: config.name, event_id: event.eventId, correlation_id: event.correlationId }));
    return send(res, 202, { accepted: true });
  }

  send(res, 404, { error: "not found" });
}

export async function start(port = config.port, dependencies = {}) {
  let eventStore = dependencies.eventStore;
  let publisher = dependencies.publisher;
  const ownsStore = config.name === "order-orchestrator" && config.databaseUrl && !eventStore;
  if (ownsStore) {
    eventStore = new EventStore({ connectionString: config.databaseUrl });
    await eventStore.migrate();
  }
  if (eventStore && !publisher) publisher = new OutboxPublisher({ store: eventStore, targets: config.eventTargets });

  const server = createServer((req, res) => route(req, res, eventStore).catch((error) => {
    console.error(JSON.stringify({ type: "error", service: config.name, message: error.message }));
    if (!res.headersSent) send(res, 502, { error: "dependency failure", correlationId: req.headers["x-correlation-id"] });
    else res.end();
  }));
  await new Promise((resolve) => server.listen(port, resolve));
  publisher?.start();
  server.on("close", async () => {
    await publisher?.stop();
    if (ownsStore) await eventStore.close();
  });
  return server;
}
