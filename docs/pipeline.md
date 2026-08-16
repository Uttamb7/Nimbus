# Pipeline

Every pull request runs dependency auditing, coverage thresholds, Compose validation, and a distributed smoke test. A push to `main` repeats those gates and publishes the verified runtime image to the repository's private GitHub Container Registry.

The smoke test starts all eight containers, performs a real checkout, and verifies that the control plane observed the expected dependency edges. Failed integration runs print service logs before cleanup.

Dependabot checks npm, Docker, and GitHub Actions dependencies weekly. Delivery uses GitHub's short-lived token and grants package-write permission only to the delivery job.
