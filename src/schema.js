import { buildSchema } from "graphql";

export const schema = buildSchema(`
  type Service { id: ID!, name: String!, version: String!, owner: String!, runtime: String! }
  type GraphEdge { source: String!, destination: String!, protocol: String!, requestCount: Int!, errorCount: Int!, averageLatencyMs: Float!, lastObserved: String! }
  type Query { services: [Service!]!, serviceGraph: [GraphEdge!]!, shortestPath(source: String!, destination: String!): [String!]! }
`);

const names = ["gateway", "identity-api", "inventory-api", "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor"];

export function root(topology) {
  return {
    services: () => names.map((name) => ({ id: name, name, version: "0.1.0", owner: "Uttam Bhattarai", runtime: "Node.js 22" })),
    serviceGraph: () => topology.edges(),
    shortestPath: ({ source, destination }) => topology.shortestPath(source, destination),
  };
}
