-- EntryManifest: the catalog listing a turn 0 FIND presents.

-- PREP: engine_list_catalog_entries
-- {§entry-owner}: canonical entries in one workspace.
-- the commons, a worker's own space, or a named space — exactly one owner's rows, its perspective.
SELECT e.id AS entry_id, e.scheme, e.authority, e.pathname, e.default_channel, ec.name AS channel, ec.content, ec.mimetype, ec.weight AS weight, ec.deep_hash,
    json_extract(e.attributes, '$.sourceProjection.mimetype') AS source_mimetype,
    d.parse_issues, d.summary,
    s.id AS subscription_id,
    CASE WHEN s.closed_at IS NULL
        THEN CAST(unixepoch('now') - unixepoch(s.opened_at) AS INTEGER)
        ELSE NULL
    END AS seconds,
    s.close_status
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
LEFT JOIN derivations d ON d.deep_hash = ec.deep_hash
LEFT JOIN subscriptions s ON s.id = (
    SELECT latest.id
    FROM subscriptions latest
    WHERE latest.entry_id = e.id
    ORDER BY latest.id DESC
    LIMIT 1
)
WHERE e.workspace_id = $workspace_id
ORDER BY e.updated_at ASC, e.id ASC, ec.name;
