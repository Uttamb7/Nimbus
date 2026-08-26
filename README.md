# Nimbus Control Panel

[![pipeline](https://github.com/Uttamb7/Nimbus/actions/workflows/ci.yml/badge.svg)](https://github.com/Uttamb7/Nimbus/actions/workflows/ci.yml)

A production-style distributed systems project by Uttam Bhattarai.

Nimbus is being built as a local operations control plane backed by measured behavior from a seven-service commerce workload. It does not claim to run on AWS.

## Run locally

```bash
docker compose up --build
curl -X POST http://localhost:8080/checkout -H "content-type: application/json" -d '{"sku":"demo","quantity":1}'
```

Health check: `http://localhost:8080/health`

GraphQL endpoint: `http://localhost:4000/graphql`

Operations console: `http://localhost:4000`

Checkout traces: `http://localhost:16686`

```graphql
{ services { name health metrics { requestRate errorRate p95LatencyMs availability } } incidents { severity title affectedServices } }
```

## Test

```bash
npm test
```

See [architecture](docs/architecture.md), [local tracing](docs/tracing.md), and [failure scenarios](docs/failure-scenarios.md).

The [pipeline](docs/pipeline.md) verifies the distributed flow and delivers a private container image after successful `main` builds.
