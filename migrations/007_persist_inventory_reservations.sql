CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  sku text NOT NULL,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
