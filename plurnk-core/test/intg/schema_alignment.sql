-- One PREP per table for PRAGMA table_info-style introspection. PRAGMA
-- doesn't accept bound params, but pragma_table_info() is a table-valued
-- function so we use a per-table SELECT. We only need column name + type;
-- the original notnull check was advisory and dropped in the SqlRite port.

-- PREP: test_align_table_exists
SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name;

-- PREP: test_align_cols_workspaces
SELECT name, type FROM pragma_table_info('workspaces');

-- PREP: test_align_cols_workers
SELECT name, type FROM pragma_table_info('workers');

-- PREP: test_align_cols_loops
SELECT name, type FROM pragma_table_info('loops');

-- PREP: test_align_cols_turns
SELECT name, type FROM pragma_table_info('turns');

-- PREP: test_align_cols_entries
SELECT name, type FROM pragma_table_info('entries');

-- PREP: test_align_cols_entry_channels
SELECT name, type FROM pragma_table_info('entry_channels');

-- PREP: test_align_cols_entry_tags
SELECT name, type FROM pragma_table_info('entry_tags');

-- PREP: test_align_cols_log_entries
SELECT name, type FROM pragma_table_info('log_entries');

-- PREP: test_align_cols_schemes
SELECT name, type FROM pragma_table_info('schemes');

-- PREP: test_align_cols_providers
SELECT name, type FROM pragma_table_info('providers');
