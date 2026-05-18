-- Subscription registry per SPEC §7.1.
-- Exists ONLY for cancellation routing: SEND[499](path) → lookup → scheme teardown.
-- Not for lifecycle tracking (log_entries carry that) or state coordination
-- (channel state column carries that).
-- Closed rows persist for forensics. Partial unique index enforces one active
-- subscription per (run, entry).

-- INIT: subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER NOT NULL PRIMARY KEY,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    run_id       INTEGER NOT NULL,
    entry_id     INTEGER NOT NULL,
    scheme       TEXT    NOT NULL CHECK (length(scheme) > 0),
    handle       TEXT    NOT NULL CHECK (length(handle) > 0),
    opened_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at    TEXT,
    close_status INTEGER          CHECK (close_status IS NULL OR (close_status BETWEEN 100 AND 599)),
    CHECK ((closed_at IS NULL AND close_status IS NULL)
        OR (closed_at IS NOT NULL AND close_status IS NOT NULL)),
    FOREIGN KEY (run_id)   REFERENCES runs(id)    ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) STRICT;

-- One active subscription per (run_id, entry_id) — closed records don't block re-subscription.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_one_per_entry
    ON subscriptions (run_id, entry_id)
    WHERE closed_at IS NULL;

-- Scheme-keyed lookup for "which scheme owns active subscriptions?" queries.
CREATE INDEX IF NOT EXISTS subscriptions_scheme_active
    ON subscriptions (scheme)
    WHERE closed_at IS NULL;

-- Forensic / time-window queries on opened_at.
CREATE INDEX IF NOT EXISTS subscriptions_opened_at ON subscriptions (opened_at);
