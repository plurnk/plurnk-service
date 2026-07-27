-- MIGRATE: 10 log_derivation
-- Search derivations describe readable content independently of its storage
-- table. Log rows attach to the same immutable content-addressed artifacts as
-- entries so semantic and graph FIND never rebuild an ad hoc query-time index.
ALTER TABLE log_entries
ADD COLUMN deep_hash TEXT REFERENCES derivations(deep_hash);

-- These artifacts were never entry-owned; entries were merely their first
-- attachment. Name the tables for the contract now that logs attach too.
ALTER TABLE entry_fts RENAME TO derivation_fts;
ALTER TABLE entry_embeddings RENAME TO derivation_embeddings;
