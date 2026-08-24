# Event delivery

The order orchestrator commits each order and its versioned event envelope in one PostgreSQL transaction. Its outbox publisher claims one due row at a time, publishes a persistent message to the durable `nimbus.orders` fanout exchange, waits for RabbitMQ's publisher confirm, and only then marks the row `PUBLISHED`.

Broker connection failures return the row to `PENDING` with capped exponential backoff and jitter. The current attempt count and failure reason stay in `outbox_events`; ten exhausted producer attempts retain the row as `DEAD_LETTER` for inspection. Payment, notification, and analytics each use a durable quorum queue and acknowledge only after their PostgreSQL receipt is recorded. Duplicate delivery therefore does not repeat the current side effect.

Consumer failures are republished to the same durable queue with publisher confirms and an incremented attempt header. The fifth failure is rejected, and RabbitMQ moves the persistent message to the durable `nimbus.dead-letter` queue with an `x-death` reason header. Inspect queue depths and dead-letter messages at `http://localhost:15672` with the local-only `nimbus` / `nimbus-local` Compose credential, or list queue state without exposing the management API:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged
```

To demonstrate restart recovery, stop RabbitMQ, submit a checkout, restart the order orchestrator, and start RabbitMQ again. The committed outbox row remains available and is published when the broker returns. Stopping a consumer before the broker returns leaves its confirmed message in that consumer's queue; restarting RabbitMQ and then the consumer delivers the retained work. The pipeline smoke test automates this sequence, duplicate redelivery, and dead-letter inspection.

RabbitMQ and PostgreSQL use local named volumes, not backups. This single-node local broker demonstrates durable at-least-once behavior but is not a highly available or production deployment.
