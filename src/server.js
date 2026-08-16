import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { body, request, send } from "./http.js";

const seenEvents = new Set();

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const correlationId = req.headers["x-correlation-id"] || randomUUID();
  res.setHeader("x-correlation-id", correlationId);

  if (url.pathname === "/health") return send(res, 200, { service: config.name, status: "healthy" });
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
    const event = { eventId: randomUUID(), correlationId, idempotencyKey: req.headers["idempotency-key"] || randomUUID(), type: "order.created", orderId: randomUUID(), reservationId: reservation.reservationId };
    setImmediate(() => Promise.allSettled(config.eventTargets.map((target) => request(target, { method: "POST", body: JSON.stringify(event) }, correlationId))));
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

export function start(port = config.port) {
  const server = createServer((req, res) => route(req, res).catch((error) => {
    console.error(JSON.stringify({ type: "error", service: config.name, message: error.message }));
    if (!res.headersSent) send(res, 502, { error: "dependency failure", correlationId: req.headers["x-correlation-id"] });
    else res.end();
  }));
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.env.NODE_ENV !== "test") start().then(() => console.log(`${config.name} listening on ${config.port}`));
