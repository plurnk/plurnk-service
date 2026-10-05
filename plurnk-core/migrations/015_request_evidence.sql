-- MIGRATE: 15 request_evidence
-- Released in 1.27.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§provider-request-evidence}: absence on historical requests remains explicit.
ALTER TABLE provider_requests ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence));
