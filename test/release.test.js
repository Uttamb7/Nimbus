import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { releaseOverride } from "../scripts/release.js";

const digest = `ghcr.io/uttamb7/nimbus@sha256:${"a".repeat(64)}`;
const passing = () => ({
  decision: "PASS", reasons: [], cleanupErrors: [],
  images: { candidate: { digest } },
});

test("release override pins every runtime service to the verified digest", () => {
  const output = releaseOverride(passing());
  assert.match(output, new RegExp(`image: ${digest}$`, "m"));
  for (const service of [
    "control-plane", "gateway", "identity-api", "inventory-api",
    "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor",
  ]) assert.match(output, new RegExp(`^  ${service}: \\*release$`, "m"));
});

test("release selection fails closed on incomplete or non-passing reports", () => {
  for (const report of [
    null,
    { ...passing(), decision: "FAIL" },
    { ...passing(), reasons: ["regression"] },
    { ...passing(), cleanupErrors: ["cleanup failed"] },
    { ...passing(), images: { candidate: { digest: "ghcr.io/uttamb7/nimbus:latest" } } },
    { ...passing(), images: { candidate: { digest: `ghcr.io/uttamb7/nimbus:${"b".repeat(40)}` } } },
  ]) assert.throws(() => releaseOverride(report));
});

test("release CLI accepts a report file and rejects malformed JSON", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nimbus-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = join(directory, "report.json");
  const invalid = join(directory, "invalid.json");
  writeFileSync(valid, JSON.stringify(passing()));
  writeFileSync(invalid, "{");
  const script = resolve("scripts/release.js");
  const output = execFileSync(process.execPath, [script, valid], { encoding: "utf8" });
  assert.equal(output, releaseOverride(passing()));
  const failed = spawnSync(process.execPath, [script, invalid], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
});
