-- MIGRATE: 15 request_evidence
-- {§provider-request-evidence}: absence on historical requests remains explicit.
ALTER TABLE provider_requests ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence));
