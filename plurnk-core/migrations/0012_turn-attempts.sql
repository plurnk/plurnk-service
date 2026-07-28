-- MIGRATE: 12 turn_attempts
-- Provider calls are attempts beneath one engine turn. A syntactically invalid
-- emission may be retried against the identical packet without becoming a turn
-- or entering model-visible history.

CREATE TABLE turn_attempts (
    id               INTEGER NOT NULL PRIMARY KEY,
    turn_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL CHECK (sequence >= 1),
    accepted         INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    response         TEXT    NOT NULL CHECK (json_valid(response)),
    parse_errors     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(parse_errors)),
    usage_prompt     INTEGER NOT NULL DEFAULT 0 CHECK (usage_prompt >= 0),
    usage_completion INTEGER NOT NULL DEFAULT 0 CHECK (usage_completion >= 0),
    usage_reasoning  INTEGER NOT NULL DEFAULT 0 CHECK (usage_reasoning >= 0),
    usage_cached     INTEGER NOT NULL DEFAULT 0 CHECK (usage_cached >= 0),
    usage_cost_usd   REAL    NOT NULL DEFAULT 0 CHECK (usage_cost_usd >= 0),
    finish_reason    TEXT,
    model            TEXT    NOT NULL CHECK (length(model) >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (turn_id, sequence),
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX turn_attempts_turn_id ON turn_attempts (turn_id);
CREATE UNIQUE INDEX turn_attempts_one_accepted_per_turn
ON turn_attempts (turn_id)
WHERE accepted = 1;

-- Historical turns expose one provider exchange through turns.packet. Preserve
-- that exchange as the accepted first attempt so the attempt relation is total
-- for every stored assistant response after migration.
INSERT INTO turn_attempts (
    turn_id,
    sequence,
    accepted,
    response,
    parse_errors,
    usage_prompt,
    usage_completion,
    usage_reasoning,
    usage_cached,
    usage_cost_usd,
    finish_reason,
    model,
    timestamp
)
SELECT
    id,
    1,
    1,
    json_object(
        'assistant', json_extract(packet, '$.assistant'),
        'assistantRaw', json_extract(packet, '$.assistantRaw'),
        'meta', json(meta)
    ),
    '[]',
    usage_prompt,
    usage_completion,
    usage_reasoning,
    usage_cached,
    usage_cost_usd,
    finish_reason,
    model,
    timestamp
FROM turns
WHERE json_type(packet, '$.assistant') = 'object';
