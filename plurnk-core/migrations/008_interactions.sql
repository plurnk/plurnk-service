-- MIGRATE: 8 interactions
-- Chapter 8 of the schema baseline ({§db-schema-baseline}): Client interactions raised by a turn.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- {§client-interactions}: the durable discoverable half of a client-owned
-- interaction. The process-local lifecycle owner holds the awaiting callable;
-- this row holds only presentation and routing facts. Settlement deletes the
-- row, so client response payloads and owner-private continuation state are
-- never copied into persistence.
CREATE TABLE IF NOT EXISTS client_interactions (
    id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    worker_id    INTEGER NOT NULL,
    loop_id      INTEGER NOT NULL,
    turn_id      INTEGER NOT NULL,
    request      TEXT    NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (loop_id)   REFERENCES loops(id)   ON DELETE CASCADE,
    FOREIGN KEY (turn_id)   REFERENCES turns(id)   ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS client_interactions_worker_id_id
    ON client_interactions (worker_id, id);

-- {§db-fk-indexes} Turn and loop inserts check interactions by their loop and turn.
CREATE INDEX IF NOT EXISTS client_interactions_loop_id ON client_interactions (loop_id);

CREATE INDEX IF NOT EXISTS client_interactions_turn_id ON client_interactions (turn_id);
