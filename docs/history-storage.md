# History storage

Nimbus stores incidents, audit events, orders, producer outbox state, and per-consumer event receipts in the local PostgreSQL container. RabbitMQ retains queued and dead-lettered messages in its own named volume. Telemetry samples, calculated service health, and observed topology remain bounded in process memory and reset when their container restarts.

`docker compose up --build` starts PostgreSQL and applies any unapplied files in `migrations/` before the control plane listens. Applied versions are recorded in `schema_migrations`, so restarting the control plane safely reruns the migration check.

Inspect the local history with:

```bash
docker compose exec postgres psql -U nimbus -d nimbus -c "select id, status, created_at from incidents order by created_at desc;"
docker compose exec postgres psql -U nimbus -d nimbus -c "select action, actor, recorded_at from audit_events order by recorded_at desc;"
docker compose exec postgres psql -U nimbus -d nimbus -c "select aggregate_id, status, attempt_count, failure_reason from outbox_events order by created_at desc;"
docker compose exec postgres psql -U nimbus -d nimbus -c "select consumer_name, event_id, received_at from consumer_receipts order by received_at desc;"
```

The Compose credentials and `DATABASE_URL` are local development defaults, not credentials for another environment. Supply `DATABASE_URL` through environment configuration outside the local stack.

The named volumes survive ordinary container restarts but are not backups. To remove all local Nimbus history and queued messages, stop the stack and delete its volumes:

```bash
docker compose down --volumes
docker compose up --build
```
