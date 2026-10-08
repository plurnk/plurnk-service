-- MIGRATE: 20 log projection
-- {§worker-wait-timing} A WAIT receipt's `waiting` is the accepted maximum in non-negative seconds;
-- a receipt without one carries no bound. The attrs guard is redeclared around this one rewrite.
DROP TRIGGER IF EXISTS log_entries_immutable_attrs;

UPDATE log_entries
SET attrs = json_remove(attrs, '$.waiting')
WHERE op = 'WAIT' AND json_extract(attrs, '$.waiting') = -1;

CREATE TRIGGER log_entries_immutable_attrs
BEFORE UPDATE OF attrs ON log_entries
WHEN COALESCE((
    json_type(OLD.attrs, '$.__plurnk_curation') = 'object'
    AND NEW.attrs = json_remove(OLD.attrs, '$.__plurnk_curation')
), 0) = 0
BEGIN
    SELECT RAISE(ABORT, 'log_entries attrs are immutable outside curation payload removal');
END;

-- {§log-history-projection} A projection row is its event's membership and folded intervals.
-- No foreign key points at log_entry_projections, so the table is rebuilt with those columns
-- ({§db-migrations}). The view that reads it and the process triggers that name it would be
-- re-resolved by the RENAME while the table is absent, so they are dropped first: the view is
-- redeclared below and the processes on the next open ({§db-process-triggers}).
CREATE TABLE log_entry_projections_rebuilt (
    log_entry_id INTEGER NOT NULL PRIMARY KEY,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    folded       TEXT    NOT NULL DEFAULT '[]'
                         CHECK (json_valid(folded) AND json_type(folded) = 'array'),
    FOREIGN KEY (log_entry_id) REFERENCES log_entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO log_entry_projections_rebuilt (log_entry_id, active, folded)
SELECT log_entry_id, active, folded FROM log_entry_projections;

DROP VIEW IF EXISTS active_log_entries;
DROP TRIGGER IF EXISTS log_entries_initialize_projection;
DROP TRIGGER IF EXISTS log_entries_apply_curation;
DROP TRIGGER IF EXISTS workers_fork_copies_history;
DROP TRIGGER IF EXISTS log_output_admission_immutable;
DROP TRIGGER IF EXISTS log_output_admission_owner;
DROP TABLE log_entry_projections;
ALTER TABLE log_entry_projections_rebuilt RENAME TO log_entry_projections;

-- A folded interval is an inclusive [start,end] pair. Ranges are positive,
-- sorted, disjoint, and non-adjacent; -1 is the final open-ended endpoint.
-- Canonical intervals make visibility equality and curation effects exact.
CREATE TRIGGER log_entry_projections_folded_valid_insert
BEFORE INSERT ON log_entry_projections
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.folded) range
    WHERE range.type != 'array'
       OR json_array_length(range.value) != 2
       OR COALESCE(json_type(range.value, '$[0]'), '') != 'integer'
       OR COALESCE(json_type(range.value, '$[1]'), '') != 'integer'
       OR json_extract(range.value, '$[0]') < 1
       OR (
           json_extract(range.value, '$[1]') != -1
           AND json_extract(range.value, '$[1]') < json_extract(range.value, '$[0]')
       )
       OR EXISTS (
           SELECT 1
           FROM json_each(NEW.folded) previous
           WHERE previous.key = range.key - 1
             AND (
                 json_extract(previous.value, '$[1]') = -1
                 OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
             )
       )
)
BEGIN
    SELECT RAISE(ABORT, 'log entry projection folded ranges are invalid');
END;

CREATE TRIGGER log_entry_projections_folded_valid_update
BEFORE UPDATE OF folded ON log_entry_projections
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.folded) range
    WHERE range.type != 'array'
       OR json_array_length(range.value) != 2
       OR COALESCE(json_type(range.value, '$[0]'), '') != 'integer'
       OR COALESCE(json_type(range.value, '$[1]'), '') != 'integer'
       OR json_extract(range.value, '$[0]') < 1
       OR (
           json_extract(range.value, '$[1]') != -1
           AND json_extract(range.value, '$[1]') < json_extract(range.value, '$[0]')
       )
       OR EXISTS (
           SELECT 1
           FROM json_each(NEW.folded) previous
           WHERE previous.key = range.key - 1
             AND (
                 json_extract(previous.value, '$[1]') = -1
                 OR json_extract(range.value, '$[0]') <= json_extract(previous.value, '$[1]') + 1
             )
       )
)
BEGIN
    SELECT RAISE(ABORT, 'log entry projection folded ranges are invalid');
END;

CREATE TRIGGER log_entry_projections_kill_terminal
BEFORE UPDATE OF active ON log_entry_projections
WHEN OLD.active = 0 AND NEW.active != 0
BEGIN
    SELECT RAISE(ABORT, 'a killed log entry cannot re-enter the active projection');
END;

CREATE TRIGGER log_entry_projections_delete_with_event_only
BEFORE DELETE ON log_entry_projections
WHEN EXISTS (SELECT 1 FROM log_entries WHERE id = OLD.log_entry_id)
BEGIN
    SELECT RAISE(ABORT, 'a durable log event must retain its projection');
END;

-- {§emission-row} An emission is curated whole: its projection is retired, never trimmed.
CREATE TRIGGER log_entry_projections_emission_whole
BEFORE UPDATE OF folded ON log_entry_projections
WHEN json(NEW.folded) != json('[]')
  AND EXISTS (
      SELECT 1 FROM log_entries
      WHERE id = NEW.log_entry_id AND json_extract(attrs, '$.kind') = 'emission'
  )
BEGIN
    SELECT RAISE(ABORT, 'an emission row is curated whole');
END;

-- The ordinary operation surface reads this view. Forensic and lifecycle
-- machinery names log_entries directly and therefore retains complete history.
CREATE VIEW active_log_entries AS
SELECT le.id, le.version, le.worker_id, le.loop_id, le.turn_id, le.sequence,
       le.at, le.origin, le.source, le.ambient_event_id, le.inherited_history,
       le.deep_hash, le.model_call_id, le.subscription_publication_id,
       le.op, le.signal, le.scheme, le.username, le.password,
       le.hostname, le.port, le.pathname, le.query, le.fragment, le.lineMarker,
       le.tx, le.mimetype_tx,
       le.rx, le.mimetype_rx, le.status_rx, le.weight,
       le.state, le.outcome, le.attrs, le.initial_folded, projection.folded
FROM log_entries le
JOIN log_entry_projections projection ON projection.log_entry_id = le.id
WHERE projection.active = 1;
