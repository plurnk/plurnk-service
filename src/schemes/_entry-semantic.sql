-- ~semantic (plurnk-service#186) — the FTS half of the dialect (FTS narrow →
-- cosine rank). Populated at the gated manifest-add hook; the FTS5 rowid IS the
-- entry id, so a re-index is delete-by-rowid then insert.

-- PREP: fts_delete
DELETE FROM entry_fts WHERE rowid = $entry_id;

-- PREP: fts_insert
INSERT INTO entry_fts (rowid, content) VALUES ($entry_id, $content);
