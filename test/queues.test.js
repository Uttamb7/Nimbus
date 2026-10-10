import test from "node:test";
import assert from "node:assert/strict";
import { Queues } from "../src/queues.js";

test("queue monitor maps only bounded Nimbus queue state", async () => {
  let requested;
  const queues = new Queues({
    baseUrl: "http://rabbitmq:15672",
    username: "nimbus",
    password: "secret",
    request: async (url, options) => {
      requested = { url, options };
      return new Response(JSON.stringify([
        { name: "other", messages_ready: 99, messages_unacknowledged: 0, consumers: 0 },
        { name: "nimbus.payment-worker", messages_ready: 3, messages_unacknowledged: 1, consumers: 0 },
        { name: "nimbus.dead-letter", messages_ready: 2, messages_unacknowledged: 0, consumers: 0 },
      ]));
    },
  });

  assert.deepEqual(await queues.list(), [
    { name: "nimbus.dead-letter", ready: 2, unacknowledged: 0, consumers: 0 },
    { name: "nimbus.payment-worker", ready: 3, unacknowledged: 1, consumers: 0 },
  ]);
  assert.equal(requested.url.href, "http://rabbitmq:15672/api/queues/%2F");
  assert.equal(requested.options.headers.authorization, "Basic bmltYnVzOnNlY3JldA==");
  assert.ok(requested.options.signal instanceof AbortSignal);
});

test("queue monitor isolates configuration, transport, and malformed responses", async () => {
  await assert.rejects(new Queues().list(), /not configured/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => { throw new Error("offline"); } }).list(), /unavailable: offline/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => new Response("bad", { status: 503 }) }).list(), /returned 503/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => new Response("{}") }).list(), /malformed/);
  await assert.rejects(new Queues({ baseUrl: "http://rabbitmq", username: "n", password: "p", request: async () => new Response('[{"name":"nimbus.dead-letter","messages_ready":-1,"messages_unacknowledged":0,"consumers":0}]') }).list(), /malformed/);
});
