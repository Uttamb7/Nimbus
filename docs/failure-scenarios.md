# Failure scenarios

## Dependency outage

1. Set `INVENTORY_FAULT_STATUS=503` in the shell or a local `.env` file.
2. Start the system with `docker compose up --build`.
3. Send a checkout request.
4. Observe a `502` from the gateway and dependency errors in the logs while health checks remain green.
5. Unset `INVENTORY_FAULT_STATUS` to restore inventory.

## Runtime fault

Use GraphQL `injectFailure(service: "order-orchestrator", status: 503, latencyMs: 900, durationSeconds: 90)` in local demo mode. Nimbus records `failure.injected`, applies the fault without restarting containers, and can reverse it with `restoreService`.

After an incident exists, Nimbus resolves it automatically only after three consecutive measured windows are back within the configured latency and error-rate thresholds. The incident update and its `nimbus-system` audit event commit together. This local-demo recovery records observed restoration; it does not restart services or roll back deployments.

## Event consumer outage

Stop `payment-worker`, then submit or republish an order event. Nimbus exposes the retained ready message immediately and creates one incident after three consecutive two-second samples report ready work with no consumer. Restart the worker; after the queue drains and three samples report a consumer with no ready work, Nimbus resolves the incident and records the recovery. Detection does not restart the worker or process the message itself.

Nimbus also detects an attached consumer that holds unacknowledged deliveries without reporting any acknowledgement rate for three samples. Any acknowledgement progress resets detection; three consecutive progressing or empty samples resolve only that matching incident. This uses aggregate RabbitMQ statistics and never inspects or replays message content.

## Dead-lettered event

After a consumer exhausts its five attempts, RabbitMQ retains the rejected message in `nimbus.dead-letter`. Three consecutive non-empty samples create one event-delivery incident. Inspect and handle the failed message through RabbitMQ operations; Nimbus does not expose its payload or replay it. After the queue is empty for three consecutive samples, Nimbus resolves the incident and records the recovery.

## Producer delivery exhaustion

When an outbox event remains pending or publishing for at least 60 seconds, or the order orchestrator exhausts its ten broker publication attempts and retains it as `DEAD_LETTER`, Nimbus creates one producer-delivery incident after three consecutive impaired samples. Inspect and repair the row through PostgreSQL operations; Nimbus exposes aggregate producer counts and the oldest unsent time, but not payloads or failure text, and does not replay or delete rows. After three healthy samples, Nimbus resolves the incident and records the recovery.
