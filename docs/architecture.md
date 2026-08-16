# Architecture

Nimbus begins with seven Node.js processes behind real HTTP boundaries. The gateway validates identity and sends orders to the orchestrator. The orchestrator reserves inventory synchronously, then dispatches an `order.created` event to three consumers asynchronously.

```text
gateway -> identity-api
gateway -> order-orchestrator -> inventory-api
                           \-> payment-worker
                           \-> notification-router
                           \-> analytics-ingestor
```

The current event transport is HTTP with at-least-once intent but no durable retry yet. It must not be described as exactly-once.
