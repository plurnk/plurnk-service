-- SearchIndex: the workspace's entries as derivation candidates.

-- PREP: engine_list_workspace_entries
-- Every owner-held entry of a workspace — all schemes, all channels — for
-- internal indexing and aggregate inspection. Addressable catalogs use the
-- owner-filtered statements above.
-- The latest subscription carries stream lifecycle into the catalog. `seconds`
-- is the live age of an open stream; close_status is the exact terminal status
-- of a closed one. Entries with no subscription remain ordinary static entries.
SELECT e.id AS entry_id, e.scheme, e.authority, e.pathname, ec.name AS channel, ec.content, ec.mimetype, ec.weight AS weight, ec.deep_hash,
    d.disposition AS deep_disposition, d.reason AS deep_reason,
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
-- User Note 5 — mtime-ascending: dormant entries hold the stable prompt-cache prefix; churn clusters at the tail.
ORDER BY e.updated_at ASC, e.id ASC, ec.name;
