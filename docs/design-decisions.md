# Design decisions

## Shared service runtime

- Decision: run seven configured instances of one small Node.js runtime.
- Alternative: seven copied applications.
- Tradeoff: services share a language and deployment shape.
- Reason: network behavior stays real without duplicating plumbing.

## Retried HTTP event delivery

- Decision: asynchronously fan out over HTTP with three bounded delivery attempts.
- Alternative: install a message broker immediately.
- Tradeoff: retries are not durable and exhausted deliveries produce a log rather than a persistent dead-letter queue.
- Reason: establish measurable retry behavior before adding broker operations and storage.

## PostgreSQL operational history

- Decision: persist incidents and audit events in local PostgreSQL while retaining high-volume telemetry in bounded memory.
- Alternative: persist every observation and calculated metric.
- Tradeoff: incident and audit history survives control-plane restarts, but topology and calculated health rebuild from new observations.
- Reason: preserve the operator timeline and provide the storage foundation for durable event delivery without turning Nimbus into a telemetry database.
