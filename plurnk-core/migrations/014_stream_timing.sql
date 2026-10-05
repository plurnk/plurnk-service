-- MIGRATE: 14 stream_timing
-- Released in 1.27.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§child-orientation}: old streams have no known output clock; do not invent one.
ALTER TABLE subscriptions ADD COLUMN output_changed_at TEXT;
