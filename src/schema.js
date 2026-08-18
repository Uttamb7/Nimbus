import { buildSchema } from "graphql";

export const schema = buildSchema(`
  enum HealthStatus { HEALTHY DEGRADED CRITICAL UNKNOWN }
  enum IncidentStatus { OPEN ACKNOWLEDGED RESOLVED }
  enum Severity { SEV1 SEV2 SEV3 }
  type ServiceMetrics { requestCount: Int!, requestRate: Float!, errorRate: Float!, p50LatencyMs: Float!, p95LatencyMs: Float!, p99LatencyMs: Float!, availability: Float!, sloCompliance: Boolean!, errorBudgetRemaining: Float! }
  type Service { id: ID!, name: String!, version: String!, owner: String!, runtime: String!, health: HealthStatus!, slo: Float!, metrics: ServiceMetrics! }
  type GraphEdge { source: String!, destination: String!, protocol: String!, requestCount: Int!, errorCount: Int!, averageLatencyMs: Float!, lastObserved: String! }
  type Incident { id: ID!, severity: Severity!, status: IncidentStatus!, title: String!, suspectedService: String!, affectedServices: [String!]!, triggerCondition: String!, createdAt: String!, acknowledgedAt: String, resolvedAt: String }
  type SystemHealth { status: HealthStatus!, healthy: Int!, degraded: Int!, critical: Int!, unknown: Int! }
  type Query { services: [Service!]!, serviceGraph: [GraphEdge!]!, shortestPath(source: String!, destination: String!): [String!]!, incidents: [Incident!]!, incident(id: ID!): Incident, systemHealth: SystemHealth! }
`);

const names = ["gateway", "identity-api", "inventory-api", "order-orchestrator", "payment-worker", "notification-router", "analytics-ingestor"];

export function root(topology, operations) {
  const service = (name) => {
    const metrics = operations.metrics(name);
    return { id: name, name, version: "0.1.0", owner: "Uttam Bhattarai", runtime: "Node.js 22", health: metrics.health, slo: operations.availabilityTarget * 100, metrics };
  };
  const incident = (value) => ({ ...value, affectedServices: [value.suspectedService, ...topology.downstream(value.suspectedService)] });
  return {
    services: () => names.map(service),
    serviceGraph: () => topology.edges(),
    shortestPath: ({ source, destination }) => topology.shortestPath(source, destination),
    incidents: () => operations.incidents().map(incident),
    incident: ({ id }) => {
      const found = operations.incidents().find((value) => value.id === id);
      return found && incident(found);
    },
    systemHealth: () => {
      const counts = names.map((name) => operations.metrics(name).health).reduce((result, health) => ({ ...result, [health.toLowerCase()]: result[health.toLowerCase()] + 1 }), { healthy: 0, degraded: 0, critical: 0, unknown: 0 });
      return { ...counts, status: counts.critical ? "CRITICAL" : counts.degraded ? "DEGRADED" : counts.healthy ? "HEALTHY" : "UNKNOWN" };
    },
  };
}
