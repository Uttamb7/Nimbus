import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

async function graphql(query, variables, token = "local-viewer") {
  const response = await fetch("http://127.0.0.1:4000/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  assert.deepEqual(result.errors, undefined);
  return result.data;
}

const compose = (args, options = {}) => execFileSync("docker", ["compose", ...args], { encoding: "utf8", ...options });
const sql = (query) => compose(["exec", "-T", "postgres", "psql", "-U", "nimbus", "-d", "nimbus", "-Atc", query]).trim();
const brokerNode = (source) => compose(["exec", "-T", "order-orchestrator", "node", "-e", source]).trim();

async function waitFor(read, predicate, message, attempts = 120) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      value = await read();
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}: ${value}`);
}

async function waitForBroker() {
  await waitFor(
    () => compose(["exec", "-T", "rabbitmq", "rabbitmq-diagnostics", "-q", "ping"]),
    (value) => value.includes("Ping succeeded"),
    "broker did not recover",
  );
}

function publishRaw(payload) {
  brokerNode(`
    (async () => {
      const { default: amqp } = await import("amqplib");
      const connection = await amqp.connect(process.env.BROKER_URL);
      const channel = await connection.createConfirmChannel();
      channel.publish("nimbus.orders", "", Buffer.from(${JSON.stringify(payload)}), { persistent: true });
      await channel.waitForConfirms();
      await connection.close();
    })().catch((error) => { console.error(error); process.exit(1); });
  `);
}

compose(["stop", "rabbitmq", "payment-worker"], { stdio: "inherit" });
const checkout = await fetch("http://127.0.0.1:8080/checkout", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": "ci-checkout" },
  body: JSON.stringify({ sku: "ci-demo", quantity: 1 }),
});
assert.equal(checkout.status, 202);
const order = await checkout.json();
assert.ok(order.orderId);
assert.ok(order.correlationId);

await waitFor(
  () => sql(`SELECT status || '|' || attempt_count FROM outbox_events WHERE aggregate_id = '${order.orderId}'`),
  (value) => value.startsWith("PENDING|") && Number(value.split("|")[1]) > 0,
  "outbox did not retain the event during broker outage",
);
compose(["restart", "order-orchestrator"], { stdio: "inherit" });
compose(["start", "rabbitmq"], { stdio: "inherit" });
await waitForBroker();
const outbox = await waitFor(
  () => sql(`SELECT status || '|' || (event->>'type') || '|' || (event->>'version') FROM outbox_events WHERE aggregate_id = '${order.orderId}'`),
  (value) => value.startsWith("PUBLISHED|"),
  "outbox event was not broker-confirmed after recovery",
);
assert.equal(outbox, "PUBLISHED|order.created|1");

const event = JSON.parse(sql(`SELECT event::text FROM outbox_events WHERE aggregate_id = '${order.orderId}'`));
compose(["restart", "rabbitmq"], { stdio: "inherit" });
await waitForBroker();
compose(["start", "payment-worker"], { stdio: "inherit" });
await waitFor(
  () => Number(sql(`SELECT count(*) FROM consumer_receipts WHERE event_id = '${event.eventId}'`)),
  (value) => value === 3,
  "consumer receipts did not recover",
);

compose(["stop", "payment-worker"], { stdio: "inherit" });
publishRaw(JSON.stringify(event));
const paymentQueueCount = () => Number(brokerNode(`
  (async () => {
    const { default: amqp } = await import("amqplib");
    const connection = await amqp.connect(process.env.BROKER_URL);
    const channel = await connection.createChannel();
    const queue = await channel.checkQueue("nimbus.payment-worker");
    console.log(queue.messageCount);
    await connection.close();
  })().catch(() => process.exit(1));
`));
await waitFor(paymentQueueCount, (value) => value === 1, "duplicate event was not retained for the stopped consumer");
compose(["start", "payment-worker"], { stdio: "inherit" });
await waitFor(
  paymentQueueCount,
  (value) => value === 0,
  "duplicate event was not acknowledged",
);
await new Promise((resolve) => setTimeout(resolve, 250));
compose(["stop", "payment-worker"], { stdio: "inherit" });
assert.equal(paymentQueueCount(), 0, "duplicate was requeued when the consumer stopped");
const receiptCount = Number(sql(`SELECT count(*) FROM consumer_receipts WHERE consumer_name = 'payment-worker' AND event_id = '${event.eventId}'`));
assert.equal(receiptCount, 1);
compose(["start", "payment-worker"], { stdio: "inherit" });

publishRaw("invalid-event");
const deadLetter = JSON.parse(brokerNode(`
  (async () => {
    const { default: amqp } = await import("amqplib");
    const connection = await amqp.connect(process.env.BROKER_URL);
    const channel = await connection.createChannel();
    for (let attempt = 0; attempt < 80; attempt++) {
      const message = await channel.get("nimbus.dead-letter");
      if (message) {
        console.log(JSON.stringify({ reason: message.properties.headers["x-death"][0].reason }));
        channel.nack(message, false, true);
        await channel.close();
        await connection.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.exit(1);
  })().catch((error) => { console.error(error); process.exit(1); });
`));
assert.deepEqual(deadLetter, { reason: "rejected" });

const query = "{ serviceGraph { source destination requestCount errorCount averageLatencyMs } }";
let edges = [];
for (let attempt = 0; attempt < 20; attempt++) {
  edges = (await graphql(query)).serviceGraph;
  if (edges.length >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

for (const dependency of ["gateway->identity-api", "gateway->order-orchestrator", "order-orchestrator->inventory-api"]) {
  assert.ok(edges.some((edge) => `${edge.source}->${edge.destination}` === dependency), `missing observed edge ${dependency}`);
}
assert.ok(edges.every((edge) => edge.requestCount > 0 && edge.averageLatencyMs >= 0));

for (let index = 0; index < 7; index++) {
  const response = await fetch("http://127.0.0.1:4000/observe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "gateway", destination: "inventory-api", status: 503, durationMs: 1_000 }),
  });
  assert.equal(response.status, 202);
}

const beforeRestart = await graphql("{ incidents { id status createdAt } }");
const incident = beforeRestart.incidents.find((value) => value.status === "OPEN");
assert.ok(incident);
await graphql("mutation($id: ID!) { acknowledgeIncident(id: $id) { action resourceId } }", { id: incident.id }, "local-operator");
await graphql("mutation($id: ID!) { resolveIncident(id: $id) { action resourceId } }", { id: incident.id }, "local-operator");

execFileSync("docker", ["compose", "restart", "control-plane"], { stdio: "inherit" });
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    ready = (await fetch("http://127.0.0.1:4000/health")).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(ready, true, "control plane did not recover after restart");

const persisted = await graphql("{ incidents { id status createdAt acknowledgedAt resolvedAt } auditLog { action resourceId } }");
assert.ok(persisted.incidents.some((value) => value.id === incident.id && value.status === "RESOLVED" && value.createdAt === incident.createdAt && value.acknowledgedAt && value.resolvedAt));
assert.ok(persisted.auditLog.some((value) => value.action === "incident.acknowledged" && value.resourceId === incident.id));
assert.ok(persisted.auditLog.some((value) => value.action === "incident.resolved" && value.resourceId === incident.id));
console.log(`checkout ${order.orderId}: broker outage and restarts recovered, duplicate suppressed, dead letter retained; ${edges.length} observed edges; incident ${incident.id} survived restart`);
