CREATE TABLE orders (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL REFERENCES orders (id),
  event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  published_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL
);

CREATE INDEX pending_outbox_delivery
  ON outbox_events (next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'PUBLISHING');
