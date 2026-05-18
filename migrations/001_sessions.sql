-- INIT: sessions
CREATE TABLE IF NOT EXISTS sessions (
    id                        INTEGER NOT NULL PRIMARY KEY,
    version                   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cost_pico                 INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0),
    scheme_registry_additions TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(scheme_registry_additions))
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at);
