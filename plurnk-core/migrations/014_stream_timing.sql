-- MIGRATE: 14 stream_timing
-- {§child-orientation}: old streams have no known output clock; do not invent one.
ALTER TABLE subscriptions ADD COLUMN output_changed_at TEXT;
