CREATE TABLE consumer_receipts (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
