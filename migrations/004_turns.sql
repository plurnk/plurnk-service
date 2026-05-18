-- INIT: turns
CREATE TABLE IF NOT EXISTS turns (
    id               INTEGER NOT NULL PRIMARY KEY,
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    usage_prompt     INTEGER NOT NULL DEFAULT 0 CHECK (usage_prompt >= 0),
    usage_completion INTEGER NOT NULL DEFAULT 0 CHECK (usage_completion >= 0),
    usage_cached     INTEGER NOT NULL DEFAULT 0 CHECK (usage_cached >= 0),
    usage_cost_pico  INTEGER NOT NULL DEFAULT 0 CHECK (usage_cost_pico >= 0),
    packet           TEXT    NOT NULL           CHECK (json_valid(packet)),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);
CREATE INDEX        IF NOT EXISTS turns_timestamp        ON turns (timestamp);
