-- {§execution-output-identity} A channel-less claim reserves the address before execution.
-- PREP: execution_output_claim
INSERT INTO entries (workspace_id, scheme, authority, pathname, output)
VALUES ($workspace_id, $scheme, '', $pathname, 1)
ON CONFLICT (workspace_id, scheme, authority, pathname) DO NOTHING
RETURNING id;

-- PREP: execution_output_describe
SELECT e.pathname, e.default_channel, ec.name AS channel, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id AND e.scheme = $scheme AND e.authority = $authority
  AND e.output = 1 AND ($pathname IS NULL OR e.pathname = $pathname);
