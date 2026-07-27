-- MIGRATE: 9 loop_terminal_result
-- A terminal loop carries the same exact universal operation result as every
-- operation and stream. status remains a constrained relational projection;
-- terminal_result is the durable product truth.
ALTER TABLE loops
ADD COLUMN terminal_result TEXT CHECK (terminal_result IS NULL OR json_valid(terminal_result));

-- Historical terminals predate durable Problems. Preserve their known status
-- and state the diagnostic loss honestly.
UPDATE loops
SET terminal_result = CASE
    WHEN status < 400 THEN json_object('status', status)
    ELSE json_object(
        'status', status,
        'problem', json_object(
            'type', 'https://problems.plurnk.dev/migration/loop/historic-failure',
            'title', 'Historic loop failure',
            'status', status,
            'detail', 'This loop failed before durable Problem Details were recorded.',
            'instance', 'loop:///' || id
        )
    )
END
WHERE status IN (200, 413, 429, 499, 500, 504, 508);

CREATE TRIGGER loops_result_contract_insert
BEFORE INSERT ON loops
WHEN NEW.status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)
AND NOT (
    (NEW.status IN (100, 102, 202) AND NEW.terminal_result IS NULL)
    OR (
        NEW.status IN (200, 413, 429, 499, 500, 504, 508)
        AND NEW.terminal_result IS NOT NULL
        AND json_valid(NEW.terminal_result)
        AND json_type(NEW.terminal_result, '$.status') = 'integer'
        AND (
            json_extract(NEW.terminal_result, '$.status') = NEW.status
            OR (
                NEW.status = 200
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 200 AND 399
                AND json_extract(NEW.terminal_result, '$.status') != 202
            )
            OR (
                NEW.status = 500
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 400 AND 599
            )
        )
        AND (
            (NEW.status < 400 AND json_type(NEW.terminal_result, '$.problem') IS NULL)
            OR (
                NEW.status >= 400
                AND json_type(NEW.terminal_result, '$.problem') = 'object'
                AND json_extract(NEW.terminal_result, '$.problem.status')
                    = json_extract(NEW.terminal_result, '$.status')
                AND length(json_extract(NEW.terminal_result, '$.problem.type')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.title')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.detail')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.instance')) > 0
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'loop terminal result violates the operation-result contract');
END;

CREATE TRIGGER loops_result_contract_update
BEFORE UPDATE OF status, terminal_result ON loops
WHEN NEW.status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)
AND NOT (
    (NEW.status IN (100, 102, 202) AND NEW.terminal_result IS NULL)
    OR (
        NEW.status IN (200, 413, 429, 499, 500, 504, 508)
        AND NEW.terminal_result IS NOT NULL
        AND json_valid(NEW.terminal_result)
        AND json_type(NEW.terminal_result, '$.status') = 'integer'
        AND (
            json_extract(NEW.terminal_result, '$.status') = NEW.status
            OR (
                NEW.status = 200
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 200 AND 399
                AND json_extract(NEW.terminal_result, '$.status') != 202
            )
            OR (
                NEW.status = 500
                AND json_extract(NEW.terminal_result, '$.status') BETWEEN 400 AND 599
            )
        )
        AND (
            (NEW.status < 400 AND json_type(NEW.terminal_result, '$.problem') IS NULL)
            OR (
                NEW.status >= 400
                AND json_type(NEW.terminal_result, '$.problem') = 'object'
                AND json_extract(NEW.terminal_result, '$.problem.status')
                    = json_extract(NEW.terminal_result, '$.status')
                AND length(json_extract(NEW.terminal_result, '$.problem.type')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.title')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.detail')) > 0
                AND length(json_extract(NEW.terminal_result, '$.problem.instance')) > 0
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'loop terminal result violates the operation-result contract');
END;
