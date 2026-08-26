# Local tracing

`docker compose up --build` starts a health-checked OpenTelemetry Collector and an in-memory Jaeger backend. Services send OTLP/HTTP traces to the Collector at `http://otel-collector:4318`; the Collector batches and forwards them to Jaeger. Open `http://localhost:16686` to use the Jaeger UI.

Run a checkout with an idempotency key, then copy `correlationId` from the response:

```bash
curl -X POST http://localhost:8080/checkout \
  -H "content-type: application/json" \
  -H "idempotency-key: trace-demo" \
  -d '{"sku":"demo","quantity":1}'
```

In Jaeger, select the `gateway` service and search with the tag `nimbus.correlation_id=<correlationId>`. The trace continues through identity, order, inventory, the persisted outbox, RabbitMQ, and all three consumers. `nimbus.idempotency_key` is also available as a safe tag. HTTP methods, status codes, durations, trace IDs, and span IDs are recorded; authorization values and request bodies are not.

Tracing is enabled in Compose by `OTEL_EXPORTER_OTLP_ENDPOINT`. Leave that variable unset to run a service without tracing; measured topology, health, and incidents continue independently. Jaeger uses memory storage, so traces are live diagnostic data rather than durable history and disappear when the Jaeger container restarts or Compose data is removed.
