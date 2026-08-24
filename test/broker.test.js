import test from "node:test";
import assert from "node:assert/strict";
import { consumers, deadLetterQueue, declareTopology, eventExchange, handleDelivery, maxConsumerAttempts, publishConfirmed } from "../src/broker.js";

const event = {
  eventId: "b08a1c40-1f55-4fc9-b0cc-d170ac248476",
  correlationId: "correlation-1",
  idempotencyKey: "checkout-1",
  type: "order.created",
  version: 1,
  createdAt: "2026-08-24T12:00:00.000Z",
  orderId: "af0fb946-d2d2-4a49-a9d4-c2e2096ba695",
  reservationId: "713615df-5085-4aec-8f45-79580c66b63d",
};

test("broker topology uses durable quorum queues with dead lettering", async () => {
  const queues = [];
  const channel = {
    assertExchange: async () => {},
    assertQueue: async (name, options) => queues.push({ name, options }),
    bindQueue: async () => {},
  };
  await declareTopology(channel);

  assert.equal(queues.length, consumers.length + 1);
  assert.equal(queues[0].name, deadLetterQueue);
  for (const { options } of queues.slice(1)) {
    assert.equal(options.durable, true);
    assert.equal(options.arguments["x-queue-type"], "quorum");
    assert.equal(options.arguments["x-dead-letter-exchange"], deadLetterQueue);
  }
});

test("publisher waits for a persistent broker confirmation", async () => {
  let published;
  let confirmed = false;
  const channel = {
    publish: (...args) => { published = args; },
    waitForConfirms: async () => { confirmed = true; },
  };
  await publishConfirmed(channel, event);

  assert.equal(published[0], eventExchange);
  assert.deepEqual(JSON.parse(published[2]), event);
  assert.equal(published[3].persistent, true);
  assert.equal(published[3].messageId, event.eventId);
  assert.equal(confirmed, true);
});

test("consumer confirms bounded retries before dead lettering", async (t) => {
  const acknowledgements = [];
  const channel = {
    ack: () => acknowledgements.push("ack"),
    nack: (_message, _all, requeue) => acknowledgements.push(["nack", requeue]),
    sendToQueue: (_queue, _content, options) => acknowledgements.push(["retry", options.headers["x-nimbus-attempt"]]),
    waitForConfirms: async () => {},
  };
  t.mock.method(console, "error", () => {});
  await handleDelivery(channel, { content: Buffer.from(JSON.stringify(event)), properties: {} }, async (received) => assert.deepEqual(received, event), "nimbus.payment-worker");
  await handleDelivery(channel, { content: Buffer.from("invalid"), properties: {} }, async () => {}, "nimbus.payment-worker");
  await handleDelivery(channel, { content: Buffer.from("invalid"), properties: { headers: { "x-nimbus-attempt": maxConsumerAttempts } } }, async () => {}, "nimbus.payment-worker");

  assert.deepEqual(acknowledgements, ["ack", ["retry", 2], "ack", ["nack", false]]);
});
