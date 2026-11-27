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
image. To render an override from a downloaded passing report, run:

```bash
node scripts/release.js canary-results/report.json > release.override.yaml
```

The selector fails without output unless the report is a clean PASS and its
candidate resolved to an immutable Nimbus digest. It emits this shape:

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

For a journaled local update with automatic restoration when the Compose health wait
fails, run:

```bash
node scripts/deploy.js canary-results/report.json deployment.json
```

The command applies only the report's immutable candidate digest to the eight runtime
services with `--no-build --wait`. It records timestamped deployment transitions in
`deployment.json`; if the candidate update fails, it applies the report's immutable
stable digest and finishes `ROLLED_BACK`, or `FAILED` when that restoration also fails.
The journal is retained and temporary overrides are removed. This command operates on
the current local Compose project; it does not retag images or change infrastructure
services. The regular pipeline's `latest` tag is a build-delivery pointer, not a
canary promotion record.

Nimbus does not deploy to AWS or production. This workflow is isolated image
verification and the deployment command updates one local stack atomically rather
than routing live traffic by percentage. Progressive 10/25/50/100 traffic shifting
and metric-triggered rollback during those stages remain future controller work.
