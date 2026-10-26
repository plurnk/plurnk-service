-- MIGRATE: 28 mutation patch
-- Released in 3.3.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§log-mutation-patch}: a settled file mutation's row keeps the unified diff of what it did, for the
-- life of the row; it is served as the row's `patch` channel and never enters a receipt or a packet.
-- Rows settled before this version, byte writes and operations that changed no text hold NULL.
ALTER TABLE log_entries ADD COLUMN patch TEXT;

DROP VIEW active_log_entries;
CREATE VIEW active_log_entries AS
SELECT le.id, le.version, le.session_id, le.loop_id, le.turn_id, le.sequence,
       le.at, le.origin, le.source, le.ambient_event_id, le.inherited_history,
       le.deep_hash, le.model_call_id, le.subscription_publication_id,
       le.op, le.signal, le.scheme, le.username, le.password,
       le.hostname, le.port, le.pathname, le.query, le.fragment, le.lineMarker,
       le.tx, le.mimetype_tx,
       le.rx, le.mimetype_rx, le.status_rx, le.weight,
       le.state, le.outcome, le.attrs, le.initial_folded, le.patch, projection.folded
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
WHERE projection.active = 1;
