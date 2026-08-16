# Design decisions

## Shared service runtime

- Decision: run seven configured instances of one small Node.js runtime.
- Alternative: seven copied applications.
- Tradeoff: services share a language and deployment shape.
- Reason: network behavior stays real without duplicating plumbing.

## HTTP event delivery

- Decision: begin with asynchronous HTTP fan-out.
- Alternative: install a message broker immediately.
- Tradeoff: delivery is not durable yet.
- Reason: establish observable service boundaries first; add a broker with retries and a DLQ in the event phase.
