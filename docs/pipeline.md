# Pipeline

Every pull request runs dependency auditing, coverage thresholds, Compose validation, and a distributed smoke test. A push to `main` repeats those gates and publishes the verified runtime image to the repository's private GitHub Container Registry.

The smoke test starts the full local stack, performs a real checkout, and verifies both the measured dependency edges and a multi-service trace through broker-outage recovery. Failed integration runs print service logs before cleanup.

Delivery uses GitHub's short-lived token and grants package-write permission only to the delivery job. Dependency updates are reviewed and committed manually by Uttamb7.
