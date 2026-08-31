# Live GraphQL updates

Connect to `ws://localhost:4000/graphql/ws` using the `graphql-transport-ws` subprotocol. The server and console use [graphql-ws](https://the-guild.dev/graphql/ws); this is not the legacy `subscriptions-transport-ws` protocol. Use `wss://` when serving the console behind HTTPS, and forward WebSocket upgrades to port 4000.

Within five seconds of opening the socket, send:

```json
{"type":"connection_init","payload":{"authorization":"Bearer local-viewer"}}
```

Wait for `connection_ack`, then send an operation with a unique ID:

```json
{"id":"health","type":"subscribe","payload":{"query":"subscription { serviceHealthChanged { name health metrics { errorRate p95LatencyMs } } }"}}
```

The same `AUTH_TOKENS` identities apply to HTTP and WebSocket connections. Viewer, operator, and admin identities can subscribe to all three fields. Invalid identities receive close code `4403`; tokens must never be placed in the URL. `local-viewer`, `local-operator`, and `local-admin` are local demo credentials only. Queries and mutations remain on authenticated `POST /graphql`, with their existing operator/admin role checks.

| Subscription field | Notification |
| --- | --- |
| `serviceHealthChanged` | Service metadata and a snapshot of health/metrics after each observation updates the in-memory sample window. |
| `incidentChanged` | Incident creation or update after the history write succeeds, including affected services. |
| `auditEventAdded` | New audit record after its history write succeeds. |

Each operation first emits its field as `null`. That initial result confirms registration; it is not a state-change event. Subsequent results contain the changed object. Send `{"id":"health","type":"complete"}` to unsubscribe.

Notifications are live and process-local, not durable event history or replay. Missed events must be reconciled by querying current state. Incident writes and audit writes notify independently after each successful write; they do not imply a transaction across both writes. Failed writes and duplicate incident inserts do not emit history notifications. A failed incident write does not roll back health samples already accepted in memory.

The console polls every three seconds while connecting or disconnected. After all three operations confirm registration, it fetches a fresh snapshot and stops polling only if that query succeeds. Later notifications trigger snapshot refreshes coalesced to at most once per second, with another refresh if changes arrive during an outstanding request. This keeps topology, history, and metrics consistent with the existing query API. A failed query resumes polling and shows `DATA UNAVAILABLE · RETRYING`.

Network disconnects show `RECONNECTING · POLLING`; retries use exponential backoff with jitter from 400–500 ms up to 24–30 seconds. Every successful reconnection registers all fields and refetches state. Connection acknowledgements time out after five seconds; application pings every ten seconds require a pong within five seconds. Authentication denial stops connection retries and leaves polling visible as `SUBSCRIPTIONS UNAVAILABLE · POLLING`; correct the credentials and reload. Navigation disposes subscriptions and timers.

The server caps connections at 64, operations at eight per connection, incoming messages at 16 KiB, and each notification queue at 32 entries. HTTP and WebSocket operations share the per-address request limit; query length, depth, and complexity limits also apply. Slow consumers with overflowing queues or excessive buffered socket output are disconnected. Queues are cleared on disconnect, and publishing never waits for subscribers or network writes. The single-process notification boundary matches the current local control plane; multiple replicas would need a shared notification transport.
