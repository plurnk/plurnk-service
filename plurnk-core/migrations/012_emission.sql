-- MIGRATE: 12 emission
-- Released in 1.24.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§emission-row} (#907): every admitted emission is announced by one `_plurnk` log row, `/emission`,
-- whose frozen body is the emission as the grammar admitted it. The packet projects that body as the
-- worker's own assistant message in the row's chronological place ({§packet-wire-envelope}).
-- No table is rebuilt (log_entries is referenced) and nothing is backfilled: earlier turns' sequences
-- are contiguous and immutable, and the canonical text needs the parser. Each invariant is stated
-- once, here, as a guard ({§validation-topology}).

-- One announcement per turn.
CREATE UNIQUE INDEX IF NOT EXISTS log_entries_emission_turn
ON log_entries (turn_id)
WHERE json_extract(attrs, '$.kind') = 'emission';

-- The announcement's shape: a born-folded, resolved `_plurnk` READ of its own turn's ops source,
-- written in a model inference or initialization turn that recorded that source, as the turn's newest
-- row. A fork copy (inherited_history = 1) keeps the author's name and passes unchanged, because fork
-- copies turn sources before log rows and inserts log rows in their original order.
CREATE TRIGGER IF NOT EXISTS log_entries_emission_shape
BEFORE INSERT ON log_entries
WHEN json_extract(NEW.attrs, '$.kind') = 'emission'
  AND NOT COALESCE((
      NEW.op = 'READ'
      AND NEW.origin = '_plurnk'
      AND NEW.source IS NULL
      AND NEW.model_call_id IS NULL
      AND NEW.lineMarker IS NULL
      AND NEW.scheme = 'ops'
      AND NEW.status_rx = 200
      AND NEW.state = 'resolved'
      AND NEW.mimetype_rx = 'application/json'
      AND json(NEW.initial_folded) = json('[[1,-1]]')
      AND json_type(NEW.rx, '$.content') = 'text'
      AND length(json_extract(NEW.rx, '$.content')) > 0
      AND NEW.pathname = (
          SELECT '/' || l.sequence || '/' || t.sequence
          FROM turns t JOIN loops l ON l.id = t.loop_id
          WHERE t.id = NEW.turn_id
      )
      AND (SELECT kind FROM turns WHERE id = NEW.turn_id) IN ('inference', 'initialization')
      AND EXISTS (
          SELECT 1 FROM turn_sources
          WHERE turn_id = NEW.turn_id AND kind = 'ops' AND sequence = 0
      )
      AND NOT EXISTS (
          SELECT 1 FROM log_entries
          WHERE turn_id = NEW.turn_id AND sequence > NEW.sequence
      )
      AND (
          NEW.inherited_history = 1
          OR NEW.hostname = (SELECT name FROM workers WHERE id = NEW.worker_id)
      )
  ), 0)
BEGIN
    SELECT RAISE(ABORT, 'an emission row is one born-folded _plurnk announcement of its own turn''s admitted ops source');
END;

-- The announcement is frozen: history never rewrites, so the prefix it anchors never moves.
-- deep_hash stays writable for search derivation.
CREATE TRIGGER IF NOT EXISTS log_entries_emission_frozen
BEFORE UPDATE OF rx, status_rx, state, outcome, weight ON log_entries
WHEN json_extract(OLD.attrs, '$.kind') = 'emission'
BEGIN
    SELECT RAISE(ABORT, 'an emission row is frozen');
END;

-- An emission is curated whole: its projection is retired, never trimmed.
CREATE TRIGGER IF NOT EXISTS log_entry_projections_emission_whole
BEFORE UPDATE OF folded ON log_entry_projections
WHEN json(NEW.folded) != json('[]')
  AND EXISTS (
      SELECT 1 FROM log_entries
      WHERE id = NEW.log_entry_id AND json_extract(attrs, '$.kind') = 'emission'
  )
BEGIN
    SELECT RAISE(ABORT, 'an emission row is curated whole');
END;
