import { randomUUID } from "node:crypto";

function report(url, status, started, correlationId) {
  const observation = { source: process.env.SERVICE_NAME, destination: new URL(url).hostname, protocol: "HTTP", status, durationMs: performance.now() - started, correlationId };
  console.log(JSON.stringify({ type: "dependency", ...observation }));
  if (process.env.TELEMETRY_URL) fetch(process.env.TELEMETRY_URL, { method: "POST", headers: { "content-type": "application/json", ...(process.env.TELEMETRY_TOKEN ? { authorization: `Bearer ${process.env.TELEMETRY_TOKEN}` } : {}) }, body: JSON.stringify(observation) }).catch(() => {});
}

export async function request(url, options = {}, correlationId = randomUUID()) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(2_000),
      headers: { "content-type": "application/json", "x-correlation-id": correlationId, ...options.headers },
    });
  } catch (error) {
    report(url, 0, started, correlationId);
    throw error;
  }
  report(url, response.status, started, correlationId);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

export function send(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  response.end(data);
}

export const maxJsonBodyBytes = 64 * 1024;

const unsupportedMediaType = () => Object.assign(
  new Error("content-type must be application/json"),
  { statusCode: 415 },
);

const payloadTooLarge = () => Object.assign(
  new Error(`request body exceeds ${maxJsonBodyBytes} bytes`),
  { statusCode: 413 },
);

export function body(request, { requireJson = false } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (requireJson && (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json")) {
      request.resume();
      reject(unsupportedMediaType());
      return;
    }
    let chunks = [], size = 0, rejected = false;
    const rejectLarge = () => {
      rejected = true;
      chunks = [];
      reject(payloadTooLarge());
    };
    if (Number(request.headers["content-length"]) > maxJsonBodyBytes) rejectLarge();
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxJsonBodyBytes) return rejectLarge();
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}
