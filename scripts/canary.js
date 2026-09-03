import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const thresholds = Object.freeze({
  minSamples: 50, minSuccessRate: 0.99, maxSuccessRateDrop: 0.01,
  maxP95Ms: 500, maxP95Ratio: 1.25, latencyAllowanceMs: 25,
});
const sampleCount = 100, warmupCount = 10, timeoutMs = 3_000;
const roles = ["stable", "candidate"];
const output = resolve("canary-results");
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 240_000 });
const configPath = (role) => resolve(output, `${role}.compose.json`);
const compose = (role, args) => docker(["compose", "-f", configPath(role), ...args]);

export function validateImage(image) {
  if (!/^ghcr\.io\/uttamb7\/nimbus(?::[a-f0-9]{40}|@sha256:[a-f0-9]{64})$/.test(image || "")) {
    throw new Error("Use a Nimbus GHCR full commit-SHA tag or sha256 digest for each image");
  }
  return image;
}

export function isolatedConfig(base, name, image) {
  const config = structuredClone(base);
  config.name = name;
  for (const volume of Object.values(config.volumes || {})) delete volume.name;
  for (const network of Object.values(config.networks || {})) delete network.name;
  for (const service of Object.values(config.services)) {
    delete service.ports;
    delete service.container_name;
    service.restart = "no";
    if (service.environment?.SERVICE_NAME) {
      delete service.build;
      service.image = image;
      service.environment.FAULT_STATUS = "";
    }
  }
  config.services.gateway.ports = [{ target: 8080, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }];
  return config;
}

export async function probe(url, checkout = false) {
  const start = performance.now();
  try {
    const response = await fetch(`${url}/${checkout ? "checkout" : "health"}`, {
      method: checkout ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: checkout ? JSON.stringify({ sku: "canary-demo", quantity: 1 }) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const body = await response.json();
    const ok = checkout
      ? response.status === 202 && body.status === "accepted" && typeof body.orderId === "string" && body.orderId.length > 0
      : response.status === 200 && body.status === "healthy";
    return { ok, status: response.status, latencyMs: performance.now() - start };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: performance.now() - start, error: error.message };
  }
}

export function summarize(samples) {
  const sorted = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  return {
    samples: samples.length, successes: samples.filter((sample) => sample.ok).length,
    successRate: samples.length ? samples.filter((sample) => sample.ok).length / samples.length : 0,
    p95LatencyMs: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
}

export function compare(stable, candidate) {
  const reasons = [];
  for (const [role, result] of Object.entries({ stable, candidate })) {
    if (result.healthy !== true) reasons.push(`${role}: unhealthy services`);
    if (!Number.isInteger(result.samples) || result.samples < thresholds.minSamples) reasons.push(`${role}: insufficient samples`);
    if (!Number.isFinite(result.successRate) || result.successRate < thresholds.minSuccessRate || result.successRate > 1) reasons.push(`${role}: success rate below threshold or invalid`);
    if (!Number.isFinite(result.p95LatencyMs) || result.p95LatencyMs < 0 || result.p95LatencyMs > thresholds.maxP95Ms) reasons.push(`${role}: p95 above threshold or invalid`);
  }
  if (candidate.successRate + thresholds.maxSuccessRateDrop + Number.EPSILON < stable.successRate) reasons.push("candidate: success rate regressed");
  if (candidate.p95LatencyMs > stable.p95LatencyMs * thresholds.maxP95Ratio + thresholds.latencyAllowanceMs) reasons.push("candidate: p95 regressed");
  return { decision: reasons.length ? "FAIL" : "PASS", reasons };
}

export function servicesHealthy(config, output) {
  const text = output.trim();
  const states = JSON.parse(text.startsWith("[") ? text : `[${text.split("\n").filter(Boolean).join(",")}]`);
  return Object.entries(config.services).every(([name, service]) => {
    const state = states.find((item) => item.Service === name);
    return state?.State === "running" && (!service.healthcheck || state.Health === "healthy");
  });
}

export function cleanup() {
  const failures = [];
  for (const role of roles) {
    if (!existsSync(configPath(role))) continue;
    try { compose(role, ["down", "--volumes", "--remove-orphans", "--timeout", "10"]); }
    catch (error) { failures.push(`${role}: ${error.message}`); }
  }
  return failures;
}

export async function run() {
  mkdirSync(output, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), thresholds, sampleCount, warmupCount, timeoutMs,
    decision: "FAIL", reasons: [], images: {}, stacks: {}, measurements: {},
  };
  try {
    const images = { stable: validateImage(process.env.STABLE_IMAGE), candidate: validateImage(process.env.CANDIDATE_IMAGE) };
    const base = JSON.parse(docker(["compose", "config", "--format", "json"]));
    const prefix = `nimbus-canary-${randomUUID().slice(0, 8)}`;
    for (const role of roles) {
      const requested = images[role];
      report.images[role] = { requested };
      docker(["pull", requested]);
      const [details] = JSON.parse(docker(["image", "inspect", requested]));
      const digest = details.RepoDigests.find((value) => value.startsWith("ghcr.io/uttamb7/nimbus@sha256:"));
      if (!digest) throw new Error(`No immutable digest found for ${role}`);
      report.images[role] = { requested, digest, imageId: details.Id };
      const config = isolatedConfig(base, `${prefix}-${role}`, digest);
      writeFileSync(configPath(role), JSON.stringify(config, null, 2));
      report.stacks[role] = { project: config.name, config };
      compose(role, ["up", "--detach", "--build", "--wait", "--wait-timeout", "180"]);
      const address = compose(role, ["port", "gateway", "8080"]).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`Unexpected ${role} port: ${address}`);
      report.stacks[role].url = `http://${address}`;
    }
    const samples = { stable: [], candidate: [] };
    const healthy = {};
    const checkServices = (role) => servicesHealthy(report.stacks[role].config, compose(role, ["ps", "--all", "--format", "json"]));
    for (const role of roles) healthy[role] = checkServices(role) && (await probe(report.stacks[role].url)).ok;
    // Alternate order to reduce bias from warm caches or host load changing over time.
    for (let i = -warmupCount; i < sampleCount; i++) {
      for (const role of i % 2 ? [...roles].reverse() : roles) {
        const sample = await probe(report.stacks[role].url, true);
        if (i >= 0) samples[role].push(sample);
      }
    }
    for (const role of roles) {
      report.measurements[role] = {
        ...summarize(samples[role]),
        healthy: healthy[role] && checkServices(role) && (await probe(report.stacks[role].url)).ok,
        requests: samples[role],
      };
    }
    Object.assign(report, compare(report.measurements.stable, report.measurements.candidate));
  } catch (error) {
    report.reasons.push(error.message);
  } finally {
    for (const role of roles) {
      if (!existsSync(configPath(role))) continue;
      try { writeFileSync(resolve(output, `${role}.log`), compose(role, ["logs", "--no-color", "--tail", "200"])); }
      catch (error) { report.reasons.push(`Unable to collect ${role} logs: ${error.message}`); }
    }
    report.cleanupErrors = cleanup();
    if (report.cleanupErrors.length || report.reasons.length) report.decision = "FAIL";
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ decision: report.decision, reasons: report.reasons, cleanupErrors: report.cleanupErrors }));
  return report.decision === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = process.argv.includes("--cleanup") ? (cleanup().length ? 1 : 0) : await run();
}
