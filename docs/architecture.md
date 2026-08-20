# Architecture

Nimbus begins with seven Node.js processes behind real HTTP boundaries. The gateway validates identity and sends orders to the orchestrator. The orchestrator reserves inventory synchronously, then dispatches an `order.created` event to three consumers asynchronously.

Every outbound call reports its measured status and duration to the control plane. The topology engine aggregates those observations into queryable dependency edges; it does not use hard-coded edges.

```text
gateway -> identity-api
gateway -> order-orchestrator -> inventory-api
                           \-> payment-worker
                           \-> notification-router
                           \-> analytics-ingestor
```

The current event transport remains HTTP, but order creation and its `order.created` envelope commit together in PostgreSQL. A background publisher atomically claims pending outbox rows, sends each event to every consumer, and marks it published only after all consumers acknowledge it. Failed attempts return to the outbox with exponential backoff and jitter; five exhausted attempts retain the event as `DEAD_LETTER` with the failure reason. A process exit no longer loses committed producer work, although consumer deduplication remains in memory until broker-backed delivery is completed. Delivery is at-least-once, not exactly-once.

The production API uses the standards-compliant `graphql` package. `POST /graphql` currently exposes the service catalog, observed graph, and BFS shortest paths.

The operations engine retains the latest 100 measured outbound calls per service. It calculates request rate, error rate, latency percentiles, availability, SLO compliance, and remaining error budget. Repeated threshold violations create a single active incident and use topology traversal to calculate affected services.

Local-demo mutations can inject or restore bounded service faults and acknowledge or resolve incidents. Each mutation appends an immutable audit event; fault endpoints require the internal demo token and are inactive unless `DEMO_MODE=true`.

Incidents, append-only audit events, orders, and producer outbox state are stored in local PostgreSQL through versioned migrations. GraphQL reads the operational history, mutation audit writes finish before success is returned, and the order orchestrator recovers pending events after restart. Telemetry samples, calculated service health, observed topology, and consumer receipts remain in memory. See [history storage](history-storage.md) for local migration, inspection, and reset operations.

The control plane serves a dependency-free web console on port 4000. Its topology, service metrics, incidents, fault actions, and audit stream all use the same GraphQL API; the current client refreshes every three seconds until subscriptions are added.

GraphQL requires a bearer identity on the backend. Viewers can read state, operators can generate traffic and manage incidents, and admins can inject or restore faults. Requests are limited by source address, query depth, query complexity, and input length. The documented `local-*` credentials exist only in Docker Compose demo mode.
