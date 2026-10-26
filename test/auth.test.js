import test from "node:test";
import assert from "node:assert/strict";
import { authenticate, authenticateToken, requireRole } from "../src/auth.js";

test("backend roles enforce operator and admin actions", () => {
  const tokens = "read:viewer:reader,operate:operator:operator,control:admin:Uttamb7";
  assert.deepEqual(authenticate("Bearer control", tokens), { role: "admin", actor: "Uttamb7" });
  assert.equal(authenticate("Bearer wrong", tokens), null);
  assert.doesNotThrow(() => requireRole(authenticate("Bearer operate", tokens), "operator"));
  assert.throws(() => requireRole(authenticate("Bearer read", tokens), "operator"), /operator role required/);
});

test("internal telemetry requires its dedicated bearer token", () => {
  assert.equal(authenticateToken("Bearer telemetry", "telemetry"), true);
  assert.equal(authenticateToken("Bearer wrong", "telemetry"), false);
  assert.equal(authenticateToken(undefined, "telemetry"), false);
  assert.equal(authenticateToken("Bearer telemetry", undefined), false);
});
