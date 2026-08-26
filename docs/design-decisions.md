# Design decisions

## Shared service runtime

- Decision: run seven configured instances of one small Node.js runtime.
- Alternative: seven copied applications.
- Tradeoff: services share a language and deployment shape.
- Reason: network behavior stays real without duplicating plumbing.

## Transactional RabbitMQ outbox

- Decision: commit orders and event envelopes together, then publish persistent messages with confirms to three durable RabbitMQ quorum queues.
- Alternative: synchronous HTTP fanout or PostgreSQL polling by every consumer.
- Tradeoff: local delivery and receipts survive ordinary restarts, but the single local RabbitMQ node is not highly available.
- Reason: RabbitMQ provides explicit publisher and consumer acknowledgements, retained per-consumer work, bounded redelivery, and dead-letter inspection without coupling order acceptance to consumers.

## PostgreSQL operational history

- Decision: persist incidents and audit events in local PostgreSQL while retaining high-volume telemetry in bounded memory.
- Alternative: persist every observation and calculated metric.
- Tradeoff: incident and audit history survives control-plane restarts, but topology and calculated health rebuild from new observations.
- Reason: preserve the operator timeline and provide the storage foundation for durable event delivery without turning Nimbus into a telemetry database.

## Local OpenTelemetry traces

- Decision: export service spans through a local OpenTelemetry Collector to an in-memory Jaeger backend.
- Alternative: send each service directly to a backend or use a hosted tracing account.
- Tradeoff: the Collector keeps service configuration vendor-neutral, while local Jaeger trace data is intentionally lost when its container restarts.
- Reason: verify one checkout across HTTP, the transactional outbox, and RabbitMQ without external credentials or claims of production traffic.
