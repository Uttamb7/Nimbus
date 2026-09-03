import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compare, isolatedConfig, probe, servicesHealthy, summarize, validateImage } from "../scripts/canary.js";

test("canary gates include threshold boundaries and reject invalid baselines", () => {
  const stable = { samples: 100, successRate: 1, p95LatencyMs: 100, healthy: true };
  const boundary = { samples: 50, successRate: 0.99, p95LatencyMs: 150, healthy: true };
  assert.equal(compare(stable, boundary).decision, "PASS");
  assert.equal(compare({ ...stable, p95LatencyMs: 500 }, { ...stable, p95LatencyMs: 500 }).decision, "PASS");
  for (const patch of [
    { samples: 49 }, { samples: NaN }, { successRate: 0.9899 },
    { successRate: NaN }, { successRate: 1.1 }, { p95LatencyMs: 150.01 },
    { p95LatencyMs: 500.01 }, { p95LatencyMs: null }, { p95LatencyMs: -1 }, { healthy: false },
  ]) assert.equal(compare(stable, { ...boundary, ...patch }).decision, "FAIL", JSON.stringify(patch));
  for (const patch of [{ samples: 0 }, { healthy: false }, { successRate: 0.5 }, { p95LatencyMs: 501 }]) {
    assert.equal(compare({ ...stable, ...patch }, stable).decision, "FAIL");
  }
  const samples = Array.from({ length: 100 }, (_, i) => ({ ok: i !== 99, latencyMs: i + 1 }));
  assert.deepEqual(summarize(samples), { samples: 100, successes: 99, successRate: 0.99, p95LatencyMs: 95 });
  assert.equal(compare(stable, { ...summarize([]), healthy: true }).decision, "FAIL");
});

test("canary projects replace runtime builds and isolate every published port and named resource", () => {
  const digest = `ghcr.io/uttamb7/nimbus@sha256:${"a".repeat(64)}`;
  validateImage(digest);
  validateImage(`ghcr.io/uttamb7/nimbus:${"b".repeat(40)}`);
  for (const bad of ["", undefined, "ghcr.io/uttamb7/nimbus:latest", "other/image:tag", `${digest};echo bad`]) {
    assert.throws(() => validateImage(bad), /full commit-SHA/);
  }
  const base = {
    name: "nimbus", volumes: { db: { name: "nimbus-db" } }, networks: { default: { name: "nimbus-default" } },
    services: {
      gateway: { build: ".", ports: ["8080:8080"], environment: { SERVICE_NAME: "gateway", FAULT_STATUS: "503" } },
      postgres: { image: "postgres:17-alpine", ports: ["5432:5432"], volumes: [{ source: "db", target: "/data" }] },
      collector: { build: "." },
    },
  };
  const config = isolatedConfig(base, "nimbus-canary-test-stable", digest);
  assert.equal(config.name, "nimbus-canary-test-stable");
  assert.equal(config.services.gateway.image, digest);
  assert.equal(config.services.gateway.build, undefined);
  assert.equal(config.services.gateway.environment.FAULT_STATUS, "");
  assert.equal(config.services.postgres.ports, undefined);
  assert.deepEqual(config.services.gateway.ports, [{ target: 8080, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }]);
  assert.equal(config.volumes.db.name, undefined);
  assert.equal(config.networks.default.name, undefined);
  assert.equal(base.services.gateway.environment.FAULT_STATUS, "503");
  assert.equal(config.services.collector.build, ".");
});

test("canary health checks require all services running and all declared checks healthy", () => {
  const config = { services: { gateway: { healthcheck: {} }, jaeger: {} } };
  const states = [{ Service: "gateway", State: "running", Health: "healthy" }, { Service: "jaeger", State: "running" }];
  assert.equal(servicesHealthy(config, JSON.stringify(states)), true);
  assert.equal(servicesHealthy(config, states.map((s) => JSON.stringify(s)).join("\n")), true);
  assert.equal(servicesHealthy(config, JSON.stringify(states.slice(0, 1))), false);
  states[0].Health = "unhealthy";
  assert.equal(servicesHealthy(config, JSON.stringify(states)), false);
  states[0].Health = "healthy";
  states[1].State = "exited";
  assert.equal(servicesHealthy(config, JSON.stringify(states)), false);
});

test("canary probes measure real responses and fail on broken checkout contracts", async (t) => {
  let mode = "healthy";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "healthy" }));
    assert.equal(req.method, "POST");
    res.statusCode = mode === "error" ? 503 : 202;
    res.end(mode === "malformed" ? "{" : JSON.stringify(mode === "healthy" ? { orderId: "test-order", status: "accepted" } : {}));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await probe(url)).ok, true);
  const success = await probe(url, true);
  assert.equal(success.ok, true);
  assert.ok(success.latencyMs > 0);
  for (mode of ["error", "empty", "malformed"]) assert.equal((await probe(url, true)).ok, false);
  await new Promise((done) => server.close(done));
  assert.equal((await probe(url, true)).ok, false);
});

test("canary CLI fails closed on invalid image input", (t) => {
  // An invalid reference is rejected before any Docker/registry operation.
  const directory = mkdtempSync(join(tmpdir(), "nimbus-canary-test-"));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => execFileSync(process.execPath, [resolve("scripts/canary.js")], {
    cwd: directory,
    env: { ...process.env, STABLE_IMAGE: "invalid", CANDIDATE_IMAGE: "invalid" },
    encoding: "utf8",
  }), (error) => error.status === 1 && error.stdout.includes('"decision":"FAIL"'));
});
