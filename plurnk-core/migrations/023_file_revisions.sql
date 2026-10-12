-- MIGRATE: 23 file revisions
-- Released in 3.2.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§file-snapshot-revision}: stat-only baselines cannot authorize content replacement.
-- Retain every projection; ordinary materialization supplies its complete revision.
UPDATE entries SET synced_sig = NULL WHERE scheme = 'file';

DROP TRIGGER entry_publication_insert;
DROP VIEW entry_publication;

CREATE VIEW entry_publication AS
SELECT NULL AS workspace_id, NULL AS scheme, NULL AS authority, NULL AS pathname,
       NULL AS attributes, NULL AS default_channel, NULL AS output,
       NULL AS channels, NULL AS created, NULL AS synced_sig
WHERE 0;

CREATE TRIGGER entry_publication_insert
INSTEAD OF INSERT ON entry_publication
BEGIN
    SELECT CASE WHEN json_type(NEW.channels) IS NOT 'object'
        THEN RAISE(ABORT, 'entry publication requires a channel object') END;
    INSERT INTO entries (workspace_id, scheme, authority, pathname, attributes, default_channel, output, synced_sig)
    VALUES (NEW.workspace_id, NEW.scheme, NEW.authority, NEW.pathname,
            COALESCE(NEW.attributes, '{}'), NEW.default_channel, NEW.output, NEW.synced_sig)
    ON CONFLICT (workspace_id, scheme, authority, pathname) DO UPDATE SET
        attributes = COALESCE(NEW.attributes, entries.attributes),
        default_channel = excluded.default_channel,
        output = MAX(entries.output, excluded.output),
        synced_sig = excluded.synced_sig;
    DELETE FROM entry_channels WHERE entry_id = (
        SELECT id FROM entries WHERE workspace_id = NEW.workspace_id
          AND scheme = NEW.scheme AND authority = NEW.authority AND pathname = NEW.pathname
    ) AND name NOT IN (SELECT key FROM json_each(NEW.channels));
    UPDATE entry_channels
    SET content = json_extract(c.value, '$.content'),
        mimetype = json_extract(c.value, '$.mimetype'),
        weight = json_extract(c.value, '$.weight'),
        content_hash = json_extract(c.value, '$.content_hash'),
        state = json_extract(c.value, '$.state'),
        producer_result = json_extract(c.value, '$.producer_result')
    FROM (SELECT key, value FROM json_each(NEW.channels)) AS c
    WHERE entry_channels.name = c.key
      AND entry_channels.entry_id = (
        SELECT id FROM entries WHERE workspace_id = NEW.workspace_id
          AND scheme = NEW.scheme AND authority = NEW.authority AND pathname = NEW.pathname
      );
    INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
    SELECT e.id, c.key, json_extract(c.value, '$.content'), json_extract(c.value, '$.mimetype'),
           json_extract(c.value, '$.weight'), json_extract(c.value, '$.content_hash'),
           json_extract(c.value, '$.state'), json_extract(c.value, '$.producer_result')
    FROM entries e, json_each(NEW.channels) c
    WHERE e.workspace_id = NEW.workspace_id AND e.scheme = NEW.scheme
      AND e.authority = NEW.authority AND e.pathname = NEW.pathname
      AND NOT EXISTS (SELECT 1 FROM entry_channel_rows r WHERE r.entry_id = e.id AND r.name = c.key);
END;
