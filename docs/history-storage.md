# History storage

Nimbus stores incidents and audit events in the local PostgreSQL container. Telemetry samples, calculated service health, and observed topology remain bounded in control-plane memory and reset when that container restarts.

`docker compose up --build` starts PostgreSQL and applies any unapplied files in `migrations/` before the control plane listens. Applied versions are recorded in `schema_migrations`, so restarting the control plane safely reruns the migration check.

Inspect the local history with:

```bash
docker compose exec postgres psql -U nimbus -d nimbus -c "select id, status, created_at from incidents order by created_at desc;"
docker compose exec postgres psql -U nimbus -d nimbus -c "select action, actor, recorded_at from audit_events order by recorded_at desc;"
```

The Compose credentials and `DATABASE_URL` are local development defaults, not credentials for another environment. Supply `DATABASE_URL` through environment configuration outside the local stack.

The named volume survives ordinary container restarts but is not a backup. To remove all local Nimbus history and recreate an empty database, stop the stack and delete its volumes:

```bash
docker compose down --volumes
docker compose up --build
```
