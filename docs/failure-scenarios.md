# Failure scenarios

## Dependency outage

1. Start the system with `docker compose up --build`.
2. Stop inventory with `docker compose stop inventory-api`.
3. Send a checkout request.
4. Observe a `502` from the gateway and dependency errors in the logs.
