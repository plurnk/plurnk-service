-- find candidate selection for entry-bearing
-- schemes (SPEC {§find}; plurnk.md find row).
--
-- Scope (target) only. The body matcher does NOT belong here:
-- per plurnk.md "Pattern Filtering" it runs against entry CONTENT, which
-- needs the mimetypes framework (xpath/jsonpath/regex/glob over structured
-- content) — so the body match runs in JS (Matcher.matchAgainstContent) over
-- the selected-channel content this query returns. Static query handles every
-- filter combination via IS-NULL guards.

-- PREP: find_workspace_entry_candidates
-- $channel: addressed channel whose content the body matcher runs against
-- $scope_prefix: the literal pathname prefix before any glob syntax, or NULL
-- for no prefix. TypeScript applies the authoritative shell-glob match; this
-- query supplies only a safe candidate superset.
SELECT e.id AS entry_id, e.authority, e.pathname, ec.name AS channel, ec.deep_hash, ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = COALESCE($channel, e.default_channel)
WHERE e.workspace_id = $workspace_id
  AND e.scheme = $scheme
  AND ($authority IS NULL OR e.authority = $authority)
  AND ($scope_prefix IS NULL OR substr(e.pathname, 1, length($scope_prefix)) = $scope_prefix)
ORDER BY e.authority, e.pathname;

-- PREP: find_workspace_entry_candidate_ids
-- Relation matchers need the same target candidate set without loading every
-- candidate body across the SQL boundary. The ranker joins these identities to
-- derivations and performs exhaustive ranking within the selected set.
SELECT e.id AS entry_id, e.authority, e.pathname, ec.name AS channel, ec.deep_hash
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = COALESCE($channel, e.default_channel)
WHERE e.workspace_id = $workspace_id
  AND e.scheme = $scheme
  AND ($authority IS NULL OR e.authority = $authority)
  AND ($scope_prefix IS NULL OR substr(e.pathname, 1, length($scope_prefix)) = $scope_prefix)
ORDER BY e.authority, e.pathname;

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

-- PREP: find_enclosing_symbol_defs
-- {§find-result-projection}: completed symbol definitions for matched candidates so
-- location evidence without a structural locator names its innermost enclosing symbol.
WITH hashes AS MATERIALIZED (
    SELECT DISTINCT value AS deep_hash
    FROM json_each($deep_hashes)
    WHERE typeof(value) = 'text'
)
SELECT h.deep_hash,
       d.id AS def_id,
       CASE WHEN d.container IS NULL OR d.container = '' THEN d.name ELSE d.container || '.' || d.name END AS locator,
       d.line,
       COALESCE(d.end_line, d.line) AS end_line,
       d.end_column
FROM hashes h
JOIN derivations x ON x.deep_hash = h.deep_hash AND x.state = 'complete'
JOIN symbol_defs d ON d.derivation_id = x.id
ORDER BY h.deep_hash, d.id;
