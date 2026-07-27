-- MIGRATE: 8 subscription_result
-- A stream concludes with the same universal operation result as every
-- synchronous operation. close_status remains a constrained relational index;
-- close_result is the exact durable product result.
ALTER TABLE subscriptions
ADD COLUMN close_result TEXT CHECK (close_result IS NULL OR json_valid(close_result));

-- Historical rows predate durable Problems. Preserve their known status and
-- state the loss honestly instead of inventing executor-specific diagnostics.
UPDATE subscriptions
SET close_result = CASE
    WHEN close_status < 400 THEN json_object('status', close_status)
    ELSE json_object(
        'status', close_status,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/migration/subscription/historic-failure',
            'title', 'Historic stream failure',
            'status', close_status,
            'detail', 'This stream failed before durable Problem Details were recorded.'
        )
    )
END
WHERE closed_at IS NOT NULL;

CREATE TRIGGER subscriptions_result_contract_insert
BEFORE INSERT ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND json_valid(NEW.close_result)
        AND json_type(NEW.close_result, '$.status') = 'integer'
        AND json_extract(NEW.close_result, '$.status') = NEW.close_status
        AND (
            (NEW.close_status < 400 AND json_type(NEW.close_result, '$.problem') IS NULL)
            OR (
                NEW.close_status >= 400
                AND json_type(NEW.close_result, '$.problem') = 'object'
                AND json_extract(NEW.close_result, '$.problem.status') = NEW.close_status
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;

CREATE TRIGGER subscriptions_result_contract_update
BEFORE UPDATE OF closed_at, close_status, close_result ON subscriptions
WHEN NOT (
    (NEW.closed_at IS NULL AND NEW.close_status IS NULL AND NEW.close_result IS NULL)
    OR (
        NEW.closed_at IS NOT NULL
        AND NEW.close_status IS NOT NULL
        AND NEW.close_result IS NOT NULL
        AND json_valid(NEW.close_result)
        AND json_type(NEW.close_result, '$.status') = 'integer'
        AND json_extract(NEW.close_result, '$.status') = NEW.close_status
        AND (
            (NEW.close_status < 400 AND json_type(NEW.close_result, '$.problem') IS NULL)
            OR (
                NEW.close_status >= 400
                AND json_type(NEW.close_result, '$.problem') = 'object'
                AND json_extract(NEW.close_result, '$.problem.status') = NEW.close_status
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'subscription terminal result violates the operation-result contract');
END;
