CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3')),
  status text NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  title text NOT NULL,
  suspected_service text NOT NULL,
  trigger_condition text NOT NULL,
  created_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

CREATE UNIQUE INDEX one_active_incident_per_service
  ON incidents (suspected_service) WHERE status <> 'RESOLVED';

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  resource_id text NOT NULL,
  metadata jsonb NOT NULL
);

CREATE FUNCTION reject_audit_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_change();
