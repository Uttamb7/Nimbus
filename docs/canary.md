# Canary image verification

Run **Canary verification** from GitHub Actions with explicit `stable_image` and
`candidate_image` inputs. Both must be `ghcr.io/uttamb7/nimbus:<full-commit-SHA>`
or `ghcr.io/uttamb7/nimbus@sha256:<digest>`. Use images from successful Nimbus
pipeline deliveries. The workflow has package-read permission only.

The verifier pulls each reference and runs the resolved digest in its own Compose
project. All runtime services use that image; each stack gets independent networks,
PostgreSQL and RabbitMQ volumes, and a dynamically allocated loopback gateway port.
Other ports are unpublished. Infrastructure versions come from the checked-out
Compose file. This tests release images against the current stack configuration;
it does not test upgrades of existing database volumes.

Each stack receives 10 warmup checkouts followed by 100 measured synthetic
checkouts. Requests alternate between stacks, time out after 3 seconds, and count
as successful only with HTTP 202 and a nonempty accepted order ID. Latency includes
the response body; nearest-rank p95 includes failed requests. Services must be
running, declared container health checks healthy, and gateway health healthy
before and after sampling.

The checked-in thresholds in `scripts/canary.js` require:

- At least 50 measured samples per stack.
- At least 99% success and p95 at most 500 ms for both stacks.
- Candidate success rate no more than one percentage point below stable.
- Candidate p95 no greater than `stable p95 × 1.25 + 25 ms`.

Equality passes. Missing data or an unhealthy baseline fails. These are local-demo
guardrails, not production SLOs or a statistical significance test. Change them
only with measured baseline evidence and review; increasing samples is preferable
to loosening thresholds to hide regressions.

Download the `canary-verification-<run>-<attempt>` artifact (14-day retention).
`report.json` records requested images, resolved digests, thresholds, sample counts,
individual measurements, decision/reasons, and cleanup errors. Compose configs and
service logs support diagnosis. Failed pulls/startup/comparisons fail the job;
cleanup removes both projects' containers, networks, and volumes even on failure,
with a second always-run cleanup step. Hosted runner disposal covers abrupt runner
termination; it may prevent complete artifact collection.

A PASS is evidence for a human release decision. It never retags or promotes an
image. To choose a verified image locally, create `release.override.yaml`, replacing
`<digest>` with the candidate digest from the report:

```yaml
x-release: &release
  image: ghcr.io/uttamb7/nimbus@sha256:<digest>
services:
  control-plane: *release
  gateway: *release
  identity-api: *release
  inventory-api: *release
  order-orchestrator: *release
  payment-worker: *release
  notification-router: *release
  analytics-ingestor: *release
```

Then run `docker compose -f compose.yaml -f release.override.yaml up -d --no-build --wait`
against an already built local stack.
Retain the old digest for manual rollback using the same command. The regular
pipeline's `latest` tag is a build-delivery pointer, not a canary promotion record.

Nimbus does not deploy to AWS or production. This workflow is isolated image
verification; percentage-based live traffic rollout and automatic rollback remain
future deployment-controller work.
