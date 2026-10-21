DROP INDEX one_active_incident_per_service;

CREATE UNIQUE INDEX one_active_incident_per_service_and_trigger
  ON incidents (suspected_service, trigger_condition) WHERE status <> 'RESOLVED';
