-- Historical forensic fixture only; never loaded by the runtime.
-- EXEC: test_make_historical_actionless_rows
PRAGMA ignore_check_constraints = ON;
DROP TRIGGER log_entries_immutable_attrs;
UPDATE log_entries SET attrs = '{"kind":"reasoning"}' WHERE sequence = 1;
UPDATE log_entries SET attrs = '{"kind":"unknown"}' WHERE sequence = 2;
PRAGMA ignore_check_constraints = OFF;
