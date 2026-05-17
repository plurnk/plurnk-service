CREATE TABLE entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    scope      TEXT    NOT NULL             CHECK (scope IN ('agent', 'session')),
    session_id INTEGER,
    scheme     TEXT                         CHECK (scheme IS NULL OR length(scheme) > 0),
    username   TEXT,
    password   TEXT,
    hostname   TEXT,
    port       INTEGER                      CHECK (port IS NULL OR (port BETWEEN 0 AND 65535)),
    pathname   TEXT    NOT NULL,
    params     TEXT                         CHECK (params IS NULL OR json_valid(params)),
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    CHECK ((scope = 'agent'   AND session_id IS NULL)
        OR (scope = 'session' AND session_id IS NOT NULL)),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX entries_agent_identity   ON entries (scheme, pathname)             WHERE scope = 'agent';
CREATE UNIQUE INDEX entries_session_identity ON entries (session_id, scheme, pathname) WHERE scope = 'session';

CREATE TABLE entry_channels (
    entry_id INTEGER NOT NULL,
    name     TEXT    NOT NULL             CHECK (length(name) > 0),
    content  TEXT    NOT NULL,
    mimetype TEXT    NOT NULL             CHECK (length(mimetype) > 0),
    tokens   INTEGER NOT NULL DEFAULT 0   CHECK (tokens >= 0),
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE entry_tags (
    entry_id INTEGER NOT NULL,
    tag      TEXT    NOT NULL CHECK (length(tag) > 0),
    PRIMARY KEY (entry_id, tag),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX entry_tags_tag ON entry_tags (tag);
