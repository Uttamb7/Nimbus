import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateImage } from "./canary.js";

const services = [
  "control-plane", "gateway", "identity-api", "inventory-api",
  "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor",
];

export function releaseOverride(report) {
  if (
    report?.decision !== "PASS"
    || !Array.isArray(report.reasons)
    || report.reasons.length
    || !Array.isArray(report.cleanupErrors)
    || report.cleanupErrors.length
  ) throw new Error("Canary report must be a clean PASS");

  const image = validateImage(report.images?.candidate?.digest);
  if (!image.includes("@sha256:")) throw new Error("Canary candidate must resolve to a digest");
  return [
    "x-release: &release", `  image: ${image}`, "services:",
    ...services.map((service) => `  ${service}: *release`), "",
  ].join("\n");
}

export function run(path) {
  if (!path) throw new Error("Usage: node scripts/release.js <canary-report.json>");
  return releaseOverride(JSON.parse(readFileSync(path, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(run(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
