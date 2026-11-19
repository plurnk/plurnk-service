-- Test-only queries preserved outside runtime src/ ({§db-migrations}).

-- PREP: crud_register_workspace_member
INSERT INTO entries (workspace_id, scheme, authority, pathname, membership_origin)
SELECT $workspace_id, $scheme, $authority, $pathname, $membership_origin
FROM workspaces WHERE id = $workspace_id
ON CONFLICT (workspace_id, scheme, authority, pathname)
DO UPDATE SET membership_origin = excluded.membership_origin
RETURNING id;

-- PREP: crud_delete_channels
DELETE FROM entry_channels WHERE entry_id = $entry_id;

-- PREP: crud_insert_family_workspace_constraint
INSERT INTO workspace_constraints (workspace_id, effect, glob, source)
VALUES ($workspace_id, $effect, $glob, $source)
ON CONFLICT (workspace_id, effect, glob)
DO NOTHING;

-- PREP: engine_list_workspace_entries
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
ORDER BY e.updated_at ASC, e.id ASC, ec.name;

-- PREP: log_set_folded_by_id
UPDATE log_entry_projections SET folded = $folded
WHERE log_entry_id = $id AND active = 1 AND json(folded) != json($folded)
RETURNING log_entry_id AS id;

-- PREP: engine_session_has_undelivered_child_term
SELECT 1 AS pending FROM unobserved_session_completions
WHERE session_id = $session_id AND kind = 'ambient'
LIMIT 1;

-- PREP: test_fork_loop_prompt_sources
SELECT sequence, status, prompt, prompt_source
FROM loops
WHERE session_id = $session_id
ORDER BY sequence;
