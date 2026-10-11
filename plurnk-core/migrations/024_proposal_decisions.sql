-- MIGRATE: 24 proposal decisions
-- {§proposal-decision-evidence}: authority precedes effects; results cannot replace decisions.
CREATE TABLE proposal_decisions (
    log_entry_id INTEGER PRIMARY KEY REFERENCES log_entries(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject', 'cancel')),
    resolver TEXT NOT NULL CHECK (length(resolver) > 0),
    body TEXT,
    outcome TEXT,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER proposal_decision_insert
BEFORE INSERT ON proposal_decisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM log_entries le JOIN workers w ON w.id = le.worker_id
        WHERE le.id = NEW.log_entry_id AND le.state = 'proposed'
          AND (NEW.resolver = '_plurnk' OR NEW.resolver = w.owner)
    ) THEN RAISE(ABORT, 'proposal decision requires a pending operation and its resolving authority') END;
END;

CREATE TRIGGER proposal_decision_immutable
BEFORE UPDATE ON proposal_decisions
BEGIN
    SELECT RAISE(ABORT, 'proposal decisions are immutable');
END;

CREATE TRIGGER proposal_decision_history_lifetime
BEFORE DELETE ON proposal_decisions
WHEN EXISTS (SELECT 1 FROM log_entries WHERE id = OLD.log_entry_id)
BEGIN
    SELECT RAISE(ABORT, 'proposal decisions belong to operation history');
END;
