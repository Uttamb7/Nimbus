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

export const topology = new Topology();
export const operations = new Operations();
export const actions = new Actions(operations);
const assets = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"] };

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (assets[url.pathname] && request.method === "GET") {
    const [file, contentType] = assets[url.pathname];
    const content = await readFile(join(process.cwd(), "web", file));
    response.writeHead(200, { "content-type": contentType, "content-length": content.length, "cache-control": "no-store", "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:", "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
    return response.end(content);
  }
  if (url.pathname === "/health") return send(response, 200, { service: config.name, status: "healthy" });
  if (url.pathname === "/observe" && request.method === "POST") {
    const observation = await body(request);
    const edge = topology.observe(observation);
    const incident = operations.observe(observation);
    return send(response, 202, { edge, incident });
  }
  if (url.pathname === "/graphql" && request.method === "POST") {
    const { query, variables } = await body(request);
    if (typeof query !== "string" || query.length > 10_000) return send(response, 400, { errors: [{ message: "invalid query" }] });
    const actor = request.headers["x-nimbus-actor"] || "local-operator";
    return send(response, 200, await graphql({ schema, source: query, rootValue: root(topology, operations, actions, actor), variableValues: variables }));
  }
  send(response, 404, { error: "not found" });
}

export function start(port = config.port) {
  const server = createServer((request, response) => route(request, response).catch((error) => send(response, 400, { errors: [{ message: error.message }] })));
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
