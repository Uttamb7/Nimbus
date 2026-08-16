# Nimbus Control Panel

A production-style distributed systems project by Uttam Bhattarai.

Nimbus is being built as a local operations control plane backed by measured behavior from a seven-service commerce workload. It does not claim to run on AWS.

## Run locally

```bash
docker compose up --build
curl -X POST http://localhost:8080/checkout -H "content-type: application/json" -d '{"sku":"demo","quantity":1}'
```

Health check: `http://localhost:8080/health`

## Test

```bash
npm test
```

See [architecture](docs/architecture.md) and [failure scenarios](docs/failure-scenarios.md).
