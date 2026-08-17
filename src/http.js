import { randomUUID } from "node:crypto";

function report(url, status, started, correlationId) {
  const observation = { source: process.env.SERVICE_NAME, destination: new URL(url).hostname, protocol: "HTTP", status, durationMs: performance.now() - started, correlationId };
  console.log(JSON.stringify({ type: "dependency", ...observation }));
  if (process.env.TELEMETRY_URL) fetch(process.env.TELEMETRY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(observation) }).catch(() => {});
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

export async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}
