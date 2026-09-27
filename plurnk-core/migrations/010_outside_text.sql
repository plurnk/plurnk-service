-- MIGRATE: 10 outside
-- #881 adds the 'outside' turn source ({§outside-text}): the response text that fell outside
-- every operation, stored verbatim beside the turn's ops and reasoning sources. The kind CHECK
-- lives in the table definition, so the table is rebuilt with the same columns, keys and
-- constraints as chapter 3 declares them; no foreign key points at turn_sources.
CREATE TABLE turn_sources_outside (
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ops', 'reasoning', 'note', 'outside')),
    sequence INTEGER NOT NULL DEFAULT 0 CHECK ((kind = 'note' AND sequence > 0) OR (kind != 'note' AND sequence = 0)),
    content TEXT NOT NULL,
    model_call_id INTEGER REFERENCES model_calls(id),
    deep_hash TEXT REFERENCES derivations(deep_hash),
    PRIMARY KEY (turn_id, kind, sequence)
) STRICT;

INSERT INTO turn_sources_outside (turn_id, kind, sequence, content, model_call_id, deep_hash)
SELECT turn_id, kind, sequence, content, model_call_id, deep_hash FROM turn_sources;

-- The fork process trigger names turn_sources and would be re-resolved by the RENAME while the
-- table is absent; it is a process, re-declared on the next open ({§db-process-triggers}), so the
-- rebuild drops it first, as SQLite's table-rebuild procedure prescribes.
DROP TRIGGER IF EXISTS workers_fork_copies_history;
DROP TABLE turn_sources;
ALTER TABLE turn_sources_outside RENAME TO turn_sources;

-- {§db-fk-indexes} A derivation replacement checks its referrers; the hash is indexed where it is a foreign key.
CREATE INDEX IF NOT EXISTS turn_sources_deep_hash ON turn_sources (deep_hash) WHERE deep_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS turn_sources_immutable
BEFORE UPDATE OF turn_id, kind, sequence, content, model_call_id ON turn_sources
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_sources_delete_with_turn_only
BEFORE DELETE ON turn_sources
WHEN EXISTS (SELECT 1 FROM turns WHERE id = OLD.turn_id)
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence belongs to its retained turn');
END;
