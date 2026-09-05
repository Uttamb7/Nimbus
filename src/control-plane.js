import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { graphql } from "graphql";
import { config } from "./config.js";
import { body, send } from "./http.js";
import { root, schema } from "./schema.js";
import { Topology } from "./topology.js";
import { Operations } from "./operations.js";
import { Actions } from "./actions.js";
import { authenticate } from "./auth.js";
import { inspectQuery, RateLimiter } from "./graphql-guard.js";
import { History } from "./history.js";
import { attachSubscriptions } from "./subscriptions.js";
import { Traces } from "./traces.js";

export const topology = new Topology();
export const history = new History({ connectionString: config.databaseUrl });
export const operations = new Operations({ history });
export const actions = new Actions(operations);
export const traces = new Traces({ baseUrl: config.jaegerQueryUrl });
const assets = { "/": ["web/index.html", "text/html; charset=utf-8"], "/app.js": ["web/app.js", "text/javascript; charset=utf-8"], "/live.js": ["web/live.js", "text/javascript; charset=utf-8"], "/graphql-ws.js": ["node_modules/graphql-ws/umd/graphql-ws.min.js", "text/javascript; charset=utf-8"], "/styles.css": ["web/styles.css", "text/css; charset=utf-8"] };
const rateLimiter = new RateLimiter();

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (assets[url.pathname] && request.method === "GET") {
    const [file, contentType] = assets[url.pathname];
    const content = await readFile(join(process.cwd(), file));
    response.writeHead(200, { "content-type": contentType, "content-length": content.length, "cache-control": "no-store", "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
    return response.end(content);
  }
  if (url.pathname === "/health") return send(response, 200, { service: config.name, status: "healthy" });
  if (url.pathname === "/observe" && request.method === "POST") {
    const observation = await body(request);
    const edge = topology.observe(observation);
    const incident = await operations.observe(observation, {
      affectedServices: [observation.source, ...topology.downstream(observation.source)],
    });
    return send(response, 202, { edge, incident });
  }
  if (url.pathname === "/graphql" && request.method === "POST") {
    if (!rateLimiter.allow(request.socket.remoteAddress || "unknown")) return send(response, 429, { errors: [{ message: "rate limit exceeded" }] });
    const identity = authenticate(request.headers.authorization, config.authTokens);
    if (!identity) return send(response, 401, { errors: [{ message: "authentication required" }] });
    const { query, variables } = await body(request);
    if (typeof query !== "string" || query.length > 10_000) return send(response, 400, { errors: [{ message: "invalid query" }] });
    inspectQuery(query);
    return send(response, 200, await graphql({ schema, source: query, rootValue: root(topology, operations, actions, identity, traces), variableValues: variables }));
  }
  send(response, 404, { error: "not found" });
}

export async function start(port = config.port) {
  await history.migrate();
  const server = createServer((request, response) => route(request, response).catch((error) => send(response, 400, { errors: [{ message: error.message }] })));
  attachSubscriptions(server, { topology, operations, authTokens: config.authTokens, rateLimiter });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
