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
