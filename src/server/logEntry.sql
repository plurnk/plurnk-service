-- Log-entry hydration for wire surfacing.

-- PREP: log_entry_by_id
SELECT * FROM log_entries WHERE id = $id;
