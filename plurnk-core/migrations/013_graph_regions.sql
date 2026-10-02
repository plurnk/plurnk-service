-- MIGRATE: 13
-- {§graph-relations}: old derived rows lack match columns. Preserve their sources
-- and history; ordinary derivation rebuilds the indexes with complete coordinates.
UPDATE entry_channel_rows SET deep_hash = NULL WHERE deep_hash IS NOT NULL;
UPDATE turn_sources SET deep_hash = NULL WHERE deep_hash IS NOT NULL;
UPDATE log_entries SET deep_hash = NULL WHERE deep_hash IS NOT NULL;
DELETE FROM derivations;
INSERT INTO derivation_fts (derivation_fts) VALUES ('rebuild');

ALTER TABLE symbol_defs ADD COLUMN column INTEGER;
ALTER TABLE symbol_defs ADD COLUMN end_column INTEGER CHECK (
    (column IS NULL AND end_column IS NULL)
    OR (column >= 1 AND end_column >= 1 AND column IS NOT NULL AND end_column IS NOT NULL
        AND end_line IS NOT NULL AND (end_line > line OR (end_line = line AND end_column >= column)))
);

DROP TABLE symbol_refs;
CREATE TABLE symbol_refs (
    id INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL REFERENCES derivations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) > 0),
    kind TEXT NOT NULL,
    container TEXT,
    line INTEGER NOT NULL CHECK (line >= 1),
    column INTEGER NOT NULL CHECK (column >= 1),
    end_line INTEGER NOT NULL,
    end_column INTEGER NOT NULL CHECK (end_column >= 1),
    CHECK (end_line > line OR (end_line = line AND end_column >= column))
) STRICT;
CREATE INDEX symbol_refs_name ON symbol_refs (name);
CREATE INDEX symbol_refs_source ON symbol_refs (derivation_id, container);
