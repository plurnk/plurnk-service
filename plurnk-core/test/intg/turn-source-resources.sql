-- PREP: test_turn_source_rewrite
UPDATE turn_sources SET content = $content WHERE turn_id = $turn_id AND kind = $kind;

-- PREP: test_turn_source_delete
DELETE FROM turn_sources WHERE turn_id = $turn_id AND kind = $kind;
