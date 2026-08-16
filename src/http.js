import { randomUUID } from "node:crypto";

export async function request(url, options = {}, correlationId = randomUUID()) {
  const started = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(2_000),
    headers: { "content-type": "application/json", "x-correlation-id": correlationId, ...options.headers },
  });
  console.log(JSON.stringify({ type: "dependency", source: process.env.SERVICE_NAME, destination: new URL(url).hostname, status: response.status, duration_ms: Math.round(performance.now() - started), correlation_id: correlationId }));
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
