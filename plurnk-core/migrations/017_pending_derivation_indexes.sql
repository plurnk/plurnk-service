-- MIGRATE: 17 pending derivation indexes
-- Released in 6.0.0 and frozen ({§db-migrations}).
-- Partial indexes for incremental SearchIndex.maintain over unindexed log rows and turn sources ({§db-migrations}, #1443).

CREATE INDEX IF NOT EXISTS log_entries_pending_derivation
    ON log_entries (session_id, id)
    WHERE deep_hash IS NULL;

CREATE INDEX IF NOT EXISTS turn_sources_pending_derivation
    ON turn_sources (turn_id)
    WHERE deep_hash IS NULL;
