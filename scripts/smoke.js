import assert from "node:assert/strict";

const checkout = await fetch("http://127.0.0.1:8080/checkout", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": "ci-checkout" },
  body: JSON.stringify({ sku: "ci-demo", quantity: 1 }),
});
assert.equal(checkout.status, 202);
const order = await checkout.json();
assert.ok(order.orderId);
assert.ok(order.correlationId);

const query = "{ serviceGraph { source destination requestCount errorCount averageLatencyMs } }";
let edges = [];
for (let attempt = 0; attempt < 20; attempt++) {
  const response = await fetch("http://127.0.0.1:4000/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  edges = result.data?.serviceGraph || [];
  if (edges.length >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

for (const dependency of ["gateway->identity-api", "gateway->order-orchestrator", "order-orchestrator->inventory-api"]) {
  assert.ok(edges.some((edge) => `${edge.source}->${edge.destination}` === dependency), `missing observed edge ${dependency}`);
}
assert.ok(edges.every((edge) => edge.requestCount > 0 && edge.averageLatencyMs >= 0));
console.log(`checkout ${order.orderId}: ${edges.length} observed edges`);
