# Failure scenarios

## Dependency outage

1. Set `INVENTORY_FAULT_STATUS=503` in the shell or a local `.env` file.
2. Start the system with `docker compose up --build`.
3. Send a checkout request.
4. Observe a `502` from the gateway and dependency errors in the logs while health checks remain green.
5. Unset `INVENTORY_FAULT_STATUS` to restore inventory.
