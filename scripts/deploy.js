import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { releaseOverrideFor, verifiedImages } from "./release.js";

const dockerCompose = (composeFile, overrideFile) => spawnSync(
  "docker",
  ["compose", "-f", composeFile, "-f", overrideFile, "up", "-d", "--no-build", "--wait"],
  { stdio: "inherit" },
);

export function deploy(report, {
  journalPath = "deployment.json",
  composeFile = "compose.yaml",
  runCompose = dockerCompose,
  now = () => new Date().toISOString(),
  id = randomUUID(),
} = {}) {
  const images = verifiedImages(report);
  const journal = {
    id,
    stableImage: images.stable,
    candidateImage: images.candidate,
    status: null,
    transitions: [],
  };
  const record = (status, reason) => {
    journal.status = status;
    journal.transitions.push({ status, timestamp: now(), ...(reason ? { reason } : {}) });
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { flush: true });
  };
  const apply = (overrideFile) => {
    try { return runCompose(composeFile, overrideFile)?.status === 0; }
    catch { return false; }
  };

  const directory = mkdtempSync(join(tmpdir(), "nimbus-deploy-"));
  try {
    const candidateOverride = join(directory, "candidate.override.yaml");
    const stableOverride = join(directory, "stable.override.yaml");
    writeFileSync(candidateOverride, releaseOverrideFor(images.candidate));
    writeFileSync(stableOverride, releaseOverrideFor(images.stable));
    record("PREPARING");
    record("DEPLOYING");
    if (apply(candidateOverride)) {
      record("SUCCEEDED");
      return { journal, exitCode: 0 };
    }
    record("ROLLING_BACK", "candidate apply failed");
    if (apply(stableOverride)) {
      record("ROLLED_BACK", "candidate apply failed");
    } else {
      record("FAILED", "candidate and rollback apply failed");
    }
    return { journal, exitCode: 1 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function run(reportPath, journalPath) {
  if (!reportPath) {
    throw new Error("Usage: node scripts/deploy.js <canary-report.json> [deployment.json]");
  }
  return deploy(JSON.parse(readFileSync(reportPath, "utf8")), {
    journalPath: journalPath || "deployment.json",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv[2], process.argv[3]).exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
