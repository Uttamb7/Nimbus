# Design decisions

## Shared service runtime

- Decision: run seven configured instances of one small Node.js runtime.
- Alternative: seven copied applications.
- Tradeoff: services share a language and deployment shape.
- Reason: network behavior stays real without duplicating plumbing.

## Transactional HTTP outbox

- Decision: commit orders and event envelopes together, then asynchronously fan out claimed outbox rows over HTTP.
- Alternative: couple order acceptance to synchronous consumer calls or wait to add persistence with the broker.
- Tradeoff: producer retries and consumer receipts survive restart, but HTTP fanout still lacks broker acknowledgements and retained queued work.
- Reason: establish the transaction boundary and reusable outbox lifecycle before replacing HTTP with broker acknowledgements.

## PostgreSQL operational history

- Decision: persist incidents and audit events in local PostgreSQL while retaining high-volume telemetry in bounded memory.
- Alternative: persist every observation and calculated metric.
- Tradeoff: incident and audit history survives control-plane restarts, but topology and calculated health rebuild from new observations.
- Reason: preserve the operator timeline and provide the storage foundation for durable event delivery without turning Nimbus into a telemetry database.
