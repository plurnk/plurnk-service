-- INIT: log_entries_lifecycle_columns
-- log_entries was append-only via the original log_entries_immutable trigger
-- (migration 006). The proposal lifecycle (task #42) needs to mutate state,
-- outcome, status_rx, and rx when a proposal resolves from 'proposed' to
-- 'resolved' / 'failed' / 'cancelled'. The other columns stay immutable
-- (audit invariant: the original action's identity and target never change).
--
-- Replaces the single blanket UPDATE trigger with a column-scoped one that
-- only fires when genuinely-immutable fields are touched.
DROP TRIGGER IF EXISTS log_entries_immutable;

CREATE TRIGGER log_entries_immutable_core
BEFORE UPDATE OF
    run_id, loop_id, turn_id, action_index, at, origin,
    op, suffix, signal,
    scheme, username, password, hostname,
    port, pathname, params, fragment,
    lineMarker, tx, mimetype_tx, mimetype_rx, attrs
ON log_entries
BEGIN
    SELECT RAISE(ABORT, 'log_entries core fields are immutable; only state/outcome/status_rx/rx may change (proposal lifecycle)');
END;
