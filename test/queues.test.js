import test from "node:test";
import assert from "node:assert/strict";
import { maxJsonBodyBytes } from "../src/http.js";
import { pollQueues, Queues } from "../src/queues.js";

const jsonResponse = (body) => new Response(body, { headers: { "content-type": "application/json" } });

test("queue monitor maps only bounded Nimbus queue state", async () => {
  let requested;
  const queues = new Queues({
    baseUrl: "http://rabbitmq:15672",
    username: "nimbus",
    password: "secret",
    request: async (url, options) => {
      requested = { url, options };
      return jsonResponse(JSON.stringify([
        { name: "other", messages_ready: 99, messages_unacknowledged: 0, consumers: 0 },
        { name: "nimbus.payment-worker", messages_ready: 3, messages_unacknowledged: 1, consumers: 0, message_stats: { ack_details: { rate: 1.5 }, publish_details: { rate: 2.5 } } },
        { name: "nimbus.dead-letter", messages_ready: 2, messages_unacknowledged: 0, consumers: 0 },
      ]));
    },
  });

  assert.deepEqual(await queues.list(), [
    { name: "nimbus.dead-letter", ready: 2, unacknowledged: 0, consumers: 0, ackRate: 0, publishRate: 0 },
    { name: "nimbus.payment-worker", ready: 3, unacknowledged: 1, consumers: 0, ackRate: 1.5, publishRate: 2.5 },
  ]);
  assert.equal(requested.url.href, "http://rabbitmq:15672/api/queues/%2F");
  assert.equal(requested.options.headers.authorization, "Basic bmltYnVzOnNlY3JldA==");
  assert.ok(requested.options.signal instanceof AbortSignal);
});

test("queue monitor isolates configuration, transport, and malformed responses", async () => {
  await assert.rejects(new Queues().list(), /not configured/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => { throw new Error("offline"); } }).list(), /unavailable: offline/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => new Response("bad", { status: 503 }) }).list(), /returned 503/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => jsonResponse("{}") }).list(), /malformed/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => new Response("[]") }).list(), /must be application\/json/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => jsonResponse('[{"name":"nimbus.dead-letter","messages_ready":-1,"messages_unacknowledged":0,"consumers":0}]') }).list(), /malformed/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => jsonResponse('[{"name":"nimbus.payment-worker","messages_ready":0,"messages_unacknowledged":1,"consumers":1,"message_stats":{"ack_details":{"rate":-1}}}]') }).list(), /malformed/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => jsonResponse('[{"name":"nimbus.payment-worker","messages_ready":0,"messages_unacknowledged":1,"consumers":1,"message_stats":{"publish_details":{"rate":-1}}}]') }).list(), /malformed/);

  let canceled = false;
  const oversized = new Response(new ReadableStream({ pull() {}, cancel() { canceled = true; } }), {
    headers: { "content-type": "application/json", "content-length": maxJsonBodyBytes + 1 },
  });
  await assert.rejects(
    new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => oversized }).list(),
    /exceeds 65536 bytes/,
  );
  assert.equal(canceled, true);
});

test("queue polling observes only consumer queues and isolates backend failures", async () => {
  const observed = [];
  const operations = {
    observeQueue: async (queue, service) => observed.push([queue.name, service]),
    observeDeadLetters: async (queue) => observed.push([queue.name, "dead-letter"]),
  };
  await pollQueues({ list: async () => [
    { name: "nimbus.payment-worker", ready: 1, unacknowledged: 0, consumers: 0 },
    { name: "nimbus.dead-letter", ready: 1, unacknowledged: 0, consumers: 0 },
  ] }, operations);
  await pollQueues({ list: async () => { throw new Error("offline"); } }, operations);
  assert.deepEqual(observed, [
    ["nimbus.payment-worker", "payment-worker"],
    ["nimbus.dead-letter", "dead-letter"],
  ]);
});
