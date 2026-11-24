import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeOnSignals } from "../src/shutdown.js";

test("shutdown signals close the server once and detach after closure", () => {
  const signals = new EventEmitter();
  const server = new EventEmitter();
  let closes = 0;
  server.close = () => { closes += 1; };
  closeOnSignals(server, signals);

  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  assert.equal(closes, 1);

  server.emit("close");
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
