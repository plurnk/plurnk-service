-- MIGRATE: 7 subscriptions
-- Chapter 7 of the schema baseline ({§db-migrations}): held streams, events and their observation cursors.
-- Released and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never
-- an edit here.

-- subscriptions
-- Durable subscription lifecycle per SPEC {§subscriptions}. The row records what
-- the session holds and routes cancellation to a separate process-local callable;
-- it never serializes that callable. Closed rows persist for forensics; partial
-- unique index enforces one active subscription per entry. Causal session and
-- resource owner may differ within the same workspace ({§execution-output-identity}).
CREATE TABLE IF NOT EXISTS subscriptions (
    id                INTEGER NOT NULL PRIMARY KEY,
    version           INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    session_id        INTEGER,
    entry_id          INTEGER NOT NULL,
    scheme            TEXT    NOT NULL CHECK (length(scheme) > 0),
    handle            TEXT    NOT NULL CHECK (length(handle) > 0),
    published_channel TEXT             CHECK (published_channel IS NULL OR length(published_channel) > 0),
    source            TEXT             CHECK (source IS NULL OR length(source) > 0),
    opened_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- `[{"lifetime":"turn"}]`: the stream is reaped at the session's next pre-turn so it never survives
    -- into the subsequent turn; its terminal output surfaces initially visible like any conclusion. {§exec-lifetime}
    turn_scoped       INTEGER NOT NULL DEFAULT 0 CHECK (turn_scoped IN (0, 1)),
    -- {§loop-completion}: a `[{"lifetime":"detached"}]` spawn outlives its loop and is nobody's obligation.
    detached          INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1)),
    closed_at         TEXT,
    close_status      INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    close_result      TEXT             CHECK (close_result IS NULL OR json_valid(close_result)),
    channel_results   TEXT             CHECK (channel_results IS NULL OR json_valid(channel_results)),
    -- {§child-orientation}: last output activity timestamp on this stream.
    output_changed_at TEXT,
    CHECK ((closed_at IS NULL AND close_status IS NULL AND close_result IS NULL AND channel_results IS NULL)
        OR (closed_at IS NOT NULL AND close_status IS NOT NULL AND close_result IS NOT NULL AND channel_results IS NOT NULL)),
    CHECK (session_id IS NOT NULL OR closed_at IS NOT NULL),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (entry_id)   REFERENCES entries(id)  ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS subscriptions_workspace_insert
BEFORE INSERT ON subscriptions
WHEN NOT EXISTS (
    SELECT 1 FROM entries e
    JOIN sessions caller ON caller.id = NEW.session_id
    WHERE e.id = NEW.entry_id AND e.workspace_id = caller.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'subscription and resource must share a workspace');
END;

CREATE TRIGGER IF NOT EXISTS subscriptions_identity_update
BEFORE UPDATE OF session_id, entry_id, scheme, source ON subscriptions
WHEN NEW.entry_id != OLD.entry_id OR NEW.scheme != OLD.scheme OR NEW.source IS NOT OLD.source
  OR (NEW.session_id IS NOT OLD.session_id AND NOT (NEW.session_id IS NULL AND NEW.closed_at IS NOT NULL))
BEGIN
    SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_one_per_entry
    ON subscriptions (entry_id)
    WHERE closed_at IS NULL;

-- {§db-migrations} Session and entry deletion, and every by-session stream lookup, otherwise scan all subscriptions,
-- closed ones included; the active-only partial indexes above do not cover foreign-key checks.
CREATE INDEX IF NOT EXISTS subscriptions_session_id ON subscriptions (session_id) WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_entry_id  ON subscriptions (entry_id);

CREATE TRIGGER IF NOT EXISTS subscriptions_result_contract_insert
BEFORE INSERT ON subscriptions
WHEN NEW.closed_at IS NOT NULL
  OR NEW.close_status IS NOT NULL
  OR NEW.close_result IS NOT NULL
  OR NEW.channel_results IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'subscription must open before it can settle');
END;

-- {§db-migrations}: matches chapter 5's `entry_channel_producer_result_contract` over `NEW.close_result`,
-- with `$.status = NEW.close_status` and NULL meaning not yet settled.
CREATE TRIGGER IF NOT EXISTS subscriptions_result_contract_update
BEFORE UPDATE OF closed_at, close_status, close_result, channel_results ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL AND NEW.channel_results IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND NEW.channel_results IS NOT NULL
        AND json_valid(NEW.channel_results)
        AND json_type(NEW.channel_results) = 'object'
        AND CASE
            WHEN NOT json_valid(NEW.close_result) THEN 0
            ELSE
                json_type(NEW.close_result) IS 'object'
                AND json_type(NEW.close_result, '$.status') IS 'integer'
                AND json_extract(NEW.close_result, '$.status') BETWEEN 200 AND 599
                AND json_extract(NEW.close_result, '$.status') != 202
                AND json_extract(NEW.close_result, '$.status') = NEW.close_status
                AND CASE
                    WHEN json_extract(NEW.close_result, '$.status') < 400 THEN
                        json_type(NEW.close_result, '$.problem') IS NULL
                    ELSE
                        json_type(NEW.close_result, '$.problem') IS 'object'
                        AND json_type(NEW.close_result, '$.problem.status') IS 'integer'
                        AND json_extract(NEW.close_result, '$.problem.status')
                            = json_extract(NEW.close_result, '$.status')
                        AND json_type(NEW.close_result, '$.problem.type') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.type')) > 0
                        AND json_type(NEW.close_result, '$.problem.title') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.title')) > 0
                        AND json_type(NEW.close_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(NEW.close_result, '$.problem.detail')) > 0
                END
        END
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;

-- A settlement may override the universal result for exact named channels.
-- Unknown channels and malformed results fail before the subscription or any
-- representation changes. The JS boundary additionally rejects projection
-- fields that are structurally unavailable in ChannelProducerResult.
CREATE TRIGGER IF NOT EXISTS subscriptions_channel_results_contract
BEFORE UPDATE OF closed_at, close_status, close_result, channel_results ON subscriptions
WHEN NEW.closed_at IS NOT NULL AND (
    EXISTS (
        SELECT 1
        FROM json_each(NEW.channel_results) AS channel_result
        LEFT JOIN entry_channels ec
          ON ec.entry_id = NEW.entry_id AND ec.name = channel_result.key
        WHERE ec.name IS NULL
           OR json_type(channel_result.value) != 'object'
           OR json_type(channel_result.value, '$.status') != 'integer'
           OR json_extract(channel_result.value, '$.status') NOT BETWEEN 200 AND 599
           OR json_extract(channel_result.value, '$.status') = 202
           OR (
                json_extract(channel_result.value, '$.status') < 400
                AND json_type(channel_result.value, '$.problem') IS NOT NULL
           )
           OR (
                json_extract(channel_result.value, '$.status') >= 400
                AND (
                    json_type(channel_result.value, '$.problem') != 'object'
                    OR json_extract(channel_result.value, '$.problem.status')
                        != json_extract(channel_result.value, '$.status')
                )
           )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription channel result violates the channel producer contract');
END;

-- {§loop-completion}: a session is held on its open streams, live children, and unanswered
-- messages sent to live recipient loops.
CREATE VIEW IF NOT EXISTS session_obligations AS
SELECT w.id AS session_id,
       EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.session_id = w.id AND s.closed_at IS NULL AND s.detached = 0
       ) AS streams,
       EXISTS (
           SELECT 1 FROM sessions c JOIN loops l ON l.session_id = c.id
           WHERE c.parent_session_id = w.id AND l.status IN (100, 102, 202)
       ) AS sessions,
       EXISTS (
           SELECT 1 FROM message_senders s
           JOIN loop_messages m ON m.id = s.message_id
           JOIN loops l ON l.id = m.loop_id
           WHERE s.sender_session_id = w.id
             AND l.status IN (100, 102, 202)
             AND NOT EXISTS (SELECT 1 FROM message_completions c WHERE c.message_id = m.id)
       ) AS messages
FROM sessions w;

CREATE VIEW IF NOT EXISTS loop_obligations AS
SELECT l.id AS loop_id, held.streams, held.sessions, held.messages
FROM loops l JOIN session_obligations held ON held.session_id = l.session_id;

-- {§exec-stream}: publication cursors survive curation of generated observations.
CREATE TABLE IF NOT EXISTS subscription_publications (
    id                 INTEGER NOT NULL PRIMARY KEY,
    version            INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    subscription_id    INTEGER NOT NULL,
    channel            TEXT    NOT NULL CHECK (length(channel) > 0),
    published_end      INTEGER NOT NULL DEFAULT 0 CHECK (published_end >= 0),
    terminal_published INTEGER NOT NULL DEFAULT 0 CHECK (terminal_published IN (0, 1)),
    UNIQUE (subscription_id, channel),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS subscription_publications_pending
    ON subscription_publications (subscription_id, terminal_published);
