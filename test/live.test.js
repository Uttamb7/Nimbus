import test from "node:test";
import assert from "node:assert/strict";
import { connectLive, retryDelay } from "../web/live.js";

const flush = () => new Promise(setImmediate);

test("console polls until subscriptions are ready, resyncs after reconnect, and cleans up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sinks = [], states = [];
  let options, refreshed = 0, disposed = 0, unsubscribed = 0, terminated = 0;
  const live = connectLive({ url: "ws://localhost/graphql/ws", authorization: "Bearer read", onState: (state) => states.push(state), refresh: async () => { refreshed++; }, createClient: (value) => {
    options = value;
    return { subscribe: (query, sink) => { sinks.push(sink); return () => { unsubscribed++; }; }, dispose: () => { disposed++; }, terminate: () => { terminated++; options.on.closed(); } };
  } });
  t.after(() => live.stop());
  await flush();
  assert.equal(refreshed, 1);
  assert.deepEqual(options.connectionParams, { authorization: "Bearer read" });
  assert.equal(options.shouldRetry({ code: 4403 }), false);
  assert.equal(options.shouldRetry({ code: 1006 }), true);
  assert.equal(states.at(-1), "CONNECTING · POLLING");
  for (const sink of sinks.slice(0, 2)) sink.next({ data: {} });
  t.mock.timers.tick(3_000); t.mock.timers.tick(1_000); await flush();
  assert.equal(refreshed, 2);
  sinks[2].next({ data: { auditEventAdded: null } });
  t.mock.timers.tick(1_000); await flush();
  assert.equal(states.at(-1), "LIVE");
  const liveCount = refreshed;
  t.mock.timers.tick(6_000); await flush();
  assert.equal(refreshed, liveCount);
  for (let i = 0; i < 100; i++) sinks[0].next({ data: { serviceHealthChanged: { name: "gateway" } } });
  t.mock.timers.tick(1_000); await flush();
  assert.equal(refreshed, liveCount + 1, "burst should coalesce into one snapshot");

  options.on.closed();
  assert.equal(states.at(-1), "RECONNECTING · POLLING");
  t.mock.timers.tick(3_000); t.mock.timers.tick(1_000); await flush();
  assert.equal(refreshed, liveCount + 2);
  for (const sink of sinks) sink.next({ data: {} });
  t.mock.timers.tick(1_000); await flush();
  assert.equal(states.at(-1), "LIVE");
  options.on.ping(false);
  options.on.pong(true);
  t.mock.timers.tick(5_000);
  assert.equal(terminated, 0);
  options.on.ping(false);
  t.mock.timers.tick(5_000);
  assert.equal(terminated, 1);
  let retried = false;
  const retry = options.retryWait(20).then(() => { retried = true; });
  t.mock.timers.tick(30_000); await retry;
  assert.equal(retried, true);
  sinks[0].error(new Error("forbidden"));
  assert.equal(states.at(-1), "SUBSCRIPTIONS UNAVAILABLE · POLLING");
  live.stop();
  assert.equal(disposed, 1);
  assert.equal(unsubscribed, 3);
  const stoppedCount = refreshed;
  t.mock.timers.tick(60_000); await flush();
  assert.equal(refreshed, stoppedCount);
});

test("console retries failed snapshots and preserves changes arriving during a refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sinks = [], states = [];
  let fail = true, finish, refreshed = 0;
  const live = connectLive({ url: "ws://localhost/graphql/ws", authorization: "Bearer read", onState: (state) => states.push(state), refresh: async () => {
    refreshed++;
    if (fail) throw new Error("offline");
    await new Promise((resolve) => { finish = resolve; });
  }, createClient: () => ({ subscribe: (_, sink) => { sinks.push(sink); return () => {}; }, dispose() {} }) });
  t.after(() => live.stop());
  await flush();
  assert.equal(states.at(-1), "DATA UNAVAILABLE · RETRYING");
  fail = false;
  for (const sink of sinks) sink.next({ data: {} });
  t.mock.timers.tick(1_000); await flush();
  sinks[0].next({ data: { serviceHealthChanged: { name: "gateway" } } });
  finish(); await flush();
  t.mock.timers.tick(1_000); await flush();
  assert.equal(refreshed, 3);
  finish(); await flush();
  assert.equal(states.at(-1), "LIVE");
  sinks[0].next({ errors: [{ message: "subscription failed" }] });
  assert.equal(states.at(-1), "SUBSCRIPTIONS UNAVAILABLE · POLLING");
});

test("reconnect backoff grows but remains bounded even after long outages", () => {
  assert.equal(retryDelay(0, () => 1), 500);
  assert.equal(retryDelay(1, () => 1), 1_000);
  assert.equal(retryDelay(100, () => 1), 30_000);
  assert.equal(retryDelay(100, () => 0), 24_000);
});
