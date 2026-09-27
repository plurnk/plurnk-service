-- MIGRATE: 11 settled
-- Released in 1.22.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- #883: two guards are redeclared so each invariant is stated once in SQL ({§validation-topology}).
-- No table is rebuilt: `subscriptions` is the parent of `subscription_publications` (ON DELETE
-- CASCADE, itself the parent of `log_entries.subscription_publication_id`), and a DROP TABLE
-- under the foreign keys sqlrite keeps on inside the migration transaction would perform the
-- implicit delete that cascades through both. A guard is shape ({§db-schema-baseline}), so its
-- redeclaration is DROP then CREATE here, verbatim but for the rule.
--
-- The settled-result invariant, in words: a settled result is a JSON object whose integer
-- `status` is 200..599 and never 202; below 400 it carries no `problem`; at 400 and above it
-- carries a `problem` object whose integer `status` equals the result's and whose `type`,
-- `title` and `detail` are non-empty strings. Chapter 5 states it as the CHECK
-- `entry_channel_producer_result_contract` over `producer_result` (where NULL is the implicit
-- 200); chapter 7's `subscriptions_result_contract_update` stated a weaker rule over
-- `close_result` (no 202 exclusion, no `type`/`title`/`detail`). Both tables store the result as
-- JSON text, so the expression below is chapter 5's text with `NEW.close_result` in place of
-- `producer_result`; the one shape difference is that `subscriptions` stores the status beside
-- the JSON, so the guard also asserts `$.status = NEW.close_status`, and NULL is "not settled"
-- (the all-null arm), never an implicit 200.
DROP TRIGGER IF EXISTS subscriptions_result_contract_update;
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

-- {§logical-line-count}: `entry_channels.lines` mirrors `TextCoordinates.lineCount`, which breaks a
-- line on LF, on CRLF and on a lone CR; chapter 5's write path counted LF only. The exact count
-- is the number of line breaks — LF count plus lone-CR count, where lone CR = CR count − CRLF
-- count — plus one for a final line the content does not terminate:
--     length(c) - length(replace(c, char(10), ''))
--   + length(c) - length(replace(c, char(13), ''))
--   - (length(c) - length(replace(c, char(13) || char(10), ''))) / 2
--   + CASE WHEN substr(c, -1) IN (char(10), char(13)) THEN 0 ELSE 1 END
-- and empty content has no line. The view's INSTEAD OF write path is redeclared with that
-- expression; every other line is chapter 5's.
DROP TRIGGER IF EXISTS entry_channels_insert;
CREATE TRIGGER IF NOT EXISTS entry_channels_insert
INSTEAD OF INSERT ON entry_channels
BEGIN
    SELECT RAISE(ABORT, 'a channel requires content') WHERE NEW.content IS NULL;
    SELECT RAISE(ABORT, 'content_hash does not match content')
    WHERE NEW.content_hash IS NOT NULL AND NEW.content_hash IS NOT sha256(NEW.content);
    INSERT INTO contents (hash, content)
    SELECT COALESCE(NEW.content_hash, sha256(NEW.content)), NEW.content
    WHERE COALESCE(NEW.state, 'static') <> 'active'
    ON CONFLICT (hash) DO NOTHING;
    INSERT INTO entry_channel_rows (entry_id, name, content_id, buffer, mimetype, weight, lines, deep_hash, state, producer_result)
    VALUES (
        NEW.entry_id, NEW.name,
        CASE WHEN COALESCE(NEW.state, 'static') <> 'active'
             THEN (SELECT id FROM contents WHERE hash = COALESCE(NEW.content_hash, sha256(NEW.content))) END,
        CASE WHEN COALESCE(NEW.state, 'static') = 'active' THEN NEW.content END,
        NEW.mimetype, COALESCE(NEW.weight, 0),
        CASE WHEN length(NEW.content) = 0 THEN 0
             ELSE length(NEW.content) - length(replace(NEW.content, char(10), ''))
                + length(NEW.content) - length(replace(NEW.content, char(13), ''))
                - (length(NEW.content) - length(replace(NEW.content, char(13) || char(10), ''))) / 2
                + CASE WHEN substr(NEW.content, -1) IN (char(10), char(13)) THEN 0 ELSE 1 END END,
        NEW.deep_hash, COALESCE(NEW.state, 'static'), NEW.producer_result
    );
END;

DROP TRIGGER IF EXISTS entry_channels_update;
CREATE TRIGGER IF NOT EXISTS entry_channels_update
INSTEAD OF UPDATE ON entry_channels
BEGIN
    SELECT RAISE(ABORT, 'a channel is addressed by (entry_id, name)')
    WHERE NEW.entry_id IS NOT OLD.entry_id OR NEW.name IS NOT OLD.name;
    SELECT RAISE(ABORT, 'a channel requires content') WHERE NEW.content IS NULL;
    SELECT RAISE(ABORT, 'content_hash does not match content')
    WHERE NEW.content_hash IS NOT NULL AND NEW.content_hash IS NOT OLD.content_hash
      AND NEW.content_hash IS NOT sha256(NEW.content);
    INSERT INTO contents (hash, content)
    SELECT sha256(NEW.content), NEW.content
    WHERE NEW.state <> 'active' AND (NEW.content IS NOT OLD.content OR OLD.state = 'active')
    ON CONFLICT (hash) DO NOTHING;
    UPDATE entry_channel_rows
    SET content_id = CASE WHEN NEW.state <> 'active'
                          THEN (SELECT id FROM contents WHERE hash = sha256(NEW.content)) END,
        buffer = CASE WHEN NEW.state = 'active' THEN NEW.content END,
        lines = CASE WHEN length(NEW.content) = 0 THEN 0
             ELSE length(NEW.content) - length(replace(NEW.content, char(10), ''))
                + length(NEW.content) - length(replace(NEW.content, char(13), ''))
                - (length(NEW.content) - length(replace(NEW.content, char(13) || char(10), ''))) / 2
                + CASE WHEN substr(NEW.content, -1) IN (char(10), char(13)) THEN 0 ELSE 1 END END
    WHERE entry_id = OLD.entry_id AND name = OLD.name
      AND (NEW.content IS NOT OLD.content OR (NEW.state = 'active') IS NOT (OLD.state = 'active'));
    UPDATE entry_channel_rows
    SET mimetype = NEW.mimetype, weight = NEW.weight, state = NEW.state, producer_result = NEW.producer_result
    WHERE entry_id = OLD.entry_id AND name = OLD.name
      AND (NEW.mimetype IS NOT OLD.mimetype OR NEW.weight IS NOT OLD.weight
           OR NEW.state IS NOT OLD.state OR NEW.producer_result IS NOT OLD.producer_result);
    UPDATE entry_channel_rows
    SET deep_hash = NEW.deep_hash
    WHERE entry_id = OLD.entry_id AND name = OLD.name AND NEW.deep_hash IS NOT OLD.deep_hash;
END;
