CREATE TABLE schemes (
    name                 TEXT    NOT NULL PRIMARY KEY CHECK (length(name) > 0),
    model_visible        INTEGER NOT NULL             CHECK (model_visible IN (0, 1)),
    category             TEXT    NOT NULL             CHECK (length(category) > 0),
    default_scope        TEXT    NOT NULL             CHECK (default_scope IN ('agent', 'session')),
    default_channel      TEXT    NOT NULL             CHECK (length(default_channel) > 0),
    channel_orientations TEXT                         CHECK (channel_orientations IS NULL OR json_valid(channel_orientations)),
    writable_by          TEXT    NOT NULL             CHECK (json_valid(writable_by)),
    volatile             INTEGER NOT NULL             CHECK (volatile IN (0, 1)),
    handler              TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE providers (
    id          INTEGER NOT NULL PRIMARY KEY,
    version     INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    provider    TEXT    NOT NULL           CHECK (length(provider) > 0),
    family      TEXT    NOT NULL           CHECK (length(family) > 0),
    model       TEXT    NOT NULL           CHECK (length(model) > 0),
    contextSize INTEGER NOT NULL           CHECK (contextSize >= 1),
    currency    TEXT    NOT NULL           CHECK (length(currency) = 3),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX providers_created_at ON providers (created_at);
