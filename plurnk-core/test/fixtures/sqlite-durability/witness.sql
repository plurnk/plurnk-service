-- MIGRATE: 2147483647 durability_witness
-- Test-only tail migration; never loaded by the production SQL registry.
CREATE TABLE durability_witness (
    id INTEGER PRIMARY KEY,
    stage TEXT NOT NULL,
    synchronous INTEGER NOT NULL,
    journal_mode TEXT NOT NULL
) STRICT;
INSERT INTO durability_witness (stage, synchronous, journal_mode)
SELECT 'migration', synchronous, journal_mode FROM pragma_synchronous, pragma_journal_mode;

-- INIT: durability_witness
INSERT INTO durability_witness (stage, synchronous, journal_mode)
SELECT 'init', synchronous, journal_mode FROM pragma_synchronous, pragma_journal_mode;

-- PREP: durability_writer
INSERT INTO durability_witness (stage, synchronous, journal_mode)
SELECT 'writer', synchronous, journal_mode FROM pragma_synchronous, pragma_journal_mode
RETURNING synchronous, journal_mode;

-- PREP: durability_reader
SELECT synchronous, journal_mode FROM pragma_synchronous, pragma_journal_mode;

-- PREP: durability_history
SELECT stage, synchronous, journal_mode FROM durability_witness ORDER BY id;

-- PREP: durability_integrity
PRAGMA integrity_check;
