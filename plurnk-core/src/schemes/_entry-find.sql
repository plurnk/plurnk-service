-- FIND / multi-entry OPEN / FOLD candidate selection for entry-bearing
-- schemes (SPEC {§find}; plurnk.md FIND row).
--
-- Scope (target) only. The body matcher does NOT belong here:
-- per plurnk.md "Pattern Filtering" it runs against entry CONTENT, which
-- needs the mimetypes plugin (xpath/jsonpath/regex/glob over structured
-- content) — so the body match runs in JS (Matcher.matchAgainstContent) over
-- the selected-channel content this query returns. Static query handles every
-- filter combination via IS-NULL guards.

-- PREP: find_workspace_entry_candidates
-- $channel: addressed channel whose content the body matcher runs against
-- $scope_prefix: the literal pathname prefix before any glob syntax, or NULL
-- for no prefix. TypeScript applies the authoritative shell-glob match; this
-- query supplies only a safe candidate superset.
SELECT e.id AS entry_id, e.authority, e.pathname, ec.deep_hash, ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = $channel
WHERE e.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = $scheme
  AND e.authority = $authority
  AND ($scope_prefix IS NULL OR substr(e.pathname, 1, length($scope_prefix)) = $scope_prefix)
ORDER BY e.pathname;

-- PREP: find_workspace_entry_candidate_ids
-- Relation matchers need the same target candidate set without loading every
-- candidate body across the SQL boundary. The ranker joins these identities to
-- derivations and performs exhaustive ranking within the selected set.
SELECT e.id AS entry_id, e.authority, e.pathname, ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = $channel
WHERE e.workspace_id = $workspace_id
  AND e.owner_id = $owner_id
  AND e.scheme = $scheme
  AND e.authority = $authority
  AND ($scope_prefix IS NULL OR substr(e.pathname, 1, length($scope_prefix)) = $scope_prefix)
ORDER BY e.pathname;

-- PREP: find_workspace_derivation_candidates
-- Graph relations resolve their source definitions across the complete
-- workspace, while the caller's target/tag candidate set still constrains
-- which addresses may be returned. Only the universal address→artifact pair
-- crosses this boundary.
SELECT (e.scheme || ':' || e.id || '#' || ec.name) AS key, ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
WHERE e.workspace_id = $workspace_id
ORDER BY e.id, ec.name;
