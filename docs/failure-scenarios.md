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
