-- INIT: log_entries_target_to_path
-- Grammar 0.8.0 dropped the `target_` prefix on LogEntry's URI-bits
-- fields. The schema now declares them as the URI bits directly:
-- `scheme`, `username`, `password`, `hostname`, `port`, `pathname`,
-- `params`, `fragment`. The LogEntry IS the addressing of what was
-- acted on; no need for an abstracting "target" namespace.
--
-- `fragment` doubles as the channel selector at request time (null =
-- the scheme's default channel). This formalizes the channel-as-URI-
-- fragment convention plurnk-service already uses for wire fences.
--
-- SQLite 3.25+ supports ALTER TABLE RENAME COLUMN, so this is eight
-- pure renames — no table recreation, indexes preserved.
ALTER TABLE log_entries RENAME COLUMN target_scheme   TO scheme;
ALTER TABLE log_entries RENAME COLUMN target_username TO username;
ALTER TABLE log_entries RENAME COLUMN target_password TO password;
ALTER TABLE log_entries RENAME COLUMN target_hostname TO hostname;
ALTER TABLE log_entries RENAME COLUMN target_port     TO port;
ALTER TABLE log_entries RENAME COLUMN target_pathname TO pathname;
ALTER TABLE log_entries RENAME COLUMN target_params   TO params;
ALTER TABLE log_entries RENAME COLUMN target_fragment TO fragment;
