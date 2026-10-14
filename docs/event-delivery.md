# Event delivery

The order orchestrator commits each order and its versioned event envelope in one PostgreSQL transaction. Its outbox publisher claims one due row at a time, publishes a persistent message to the durable `nimbus.orders` fanout exchange, waits for RabbitMQ's publisher confirm, and only then marks the row `PUBLISHED`.

Broker connection failures return the row to `PENDING` with capped exponential backoff and jitter. The current attempt count and failure reason stay in `outbox_events`; ten exhausted producer attempts retain the row as `DEAD_LETTER` for inspection. Payment, notification, and analytics each use a durable quorum queue and acknowledge only after their PostgreSQL receipt is recorded. Duplicate delivery therefore does not repeat the current side effect.

Consumer failures are republished to the same durable queue with publisher confirms and an incremented attempt header. The fifth failure is rejected, and RabbitMQ moves the persistent message to the durable `nimbus.dead-letter` queue with an `x-death` reason header. The console and viewer-authorized `eventQueues` GraphQL query report live ready, unacknowledged, and consumer counts for the three consumer queues and dead-letter queue. The control plane uses a bounded internal management request; credentials, other queues, and arbitrary endpoints are not exposed. This queue state is neither persisted nor historical, and an unavailable broker does not prevent other dashboard data from loading.

The control plane samples the three consumer queues every two seconds. Three consecutive samples with ready messages and no consumer create one persisted SEV-2 incident for that consumer. After the consumer returns, three consecutive samples with no ready messages resolve that matching incident and append a `nimbus-system` audit event. Missing or unavailable queue data is ignored rather than treated as a failure or recovery signal. Dead-letter depth remains visible but does not use the stopped-consumer rule.

The same poll treats three consecutive non-empty `nimbus.dead-letter` samples as a separate SEV-2 event-delivery incident. Three consecutive empty samples resolve it and record a `nimbus-system` audit event. Nimbus uses only aggregate queue counts for this signal; it does not inspect or replay dead-lettered messages or infer which consumer failed.

The console and viewer-authorized `outboxState` query separately report aggregate PostgreSQL producer counts and the oldest unsent timestamp. Three consecutive samples containing producer `DEAD_LETTER` rows create a SEV-2 producer-delivery incident; three clear samples resolve it and append a `nimbus-system` audit event. Failed database reads are ignored rather than treated as either state. Nimbus never exposes the stored event, row identifiers, or failure reason and does not retry, delete, or replay these rows.

Inspect queue depths and dead-letter messages at `http://localhost:15672` with the local-only `nimbus` / `nimbus-local` Compose credential, or list queue state directly:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged
```

To demonstrate restart recovery, stop RabbitMQ, submit a checkout, restart the order orchestrator, and start RabbitMQ again. The committed outbox row remains available and is published when the broker returns. Stopping a consumer before the broker returns leaves its confirmed message in that consumer's queue; restarting RabbitMQ and then the consumer delivers the retained work. The pipeline smoke test automates this sequence, duplicate redelivery, and dead-letter inspection.

RabbitMQ and PostgreSQL use local named volumes, not backups. This single-node local broker demonstrates durable at-least-once behavior but is not a highly available or production deployment.
