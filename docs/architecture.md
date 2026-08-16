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

The current event transport is HTTP with at-least-once intent but no durable retry yet. It must not be described as exactly-once.

The production API uses the standards-compliant `graphql` package. `POST /graphql` currently exposes the service catalog, observed graph, and BFS shortest paths.
