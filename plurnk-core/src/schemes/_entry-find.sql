-- FIND / multi-entry OPEN / FOLD candidate selection for entry-bearing
-- schemes (SPEC §find; plurnk.md FIND row).
--
-- Scope (target) + tag filters ONLY. The body matcher does NOT belong here:
-- per plurnk.md §"Body matcher dispatch" it runs against entry CONTENT, which
-- needs the mimetypes daughter (xpath/jsonpath/regex/glob over structured
-- content) — so the body match runs in JS (Matcher.matchAgainstContent) over
-- the default-channel content this query returns. Static query handles every
-- filter combination via IS-NULL guards (per SqlRite LLMS.md §channels).

-- PREP: find_workspace_entry_candidates
-- $channel: default-channel name whose content the body matcher runs against
-- $scope_pathname: pathname-prefix glob (e.g., "foo/*") or NULL for no prefix
-- $tags: JSON string of tag list (e.g., '["a","b"]'); '[]' or NULL for no tag filter
SELECT e.id AS entry_id, e.pathname, ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = $channel
WHERE e.scope = 'workspace'
  AND e.workspace_id = $workspace_id
  AND e.scheme IS $scheme
  AND ($scope_pathname IS NULL OR e.pathname GLOB $scope_pathname)
  AND (
    json_array_length(COALESCE($tags, '[]')) = 0
    OR e.id IN (
        SELECT entry_id FROM entry_tags
        WHERE tag IN (SELECT value FROM json_each(COALESCE($tags, '[]')))
        GROUP BY entry_id
        HAVING COUNT(DISTINCT tag) = json_array_length(COALESCE($tags, '[]'))
    )
  )
ORDER BY e.pathname;

-- PREP: find_worker_entry_candidates
-- §worker-scheme — worker-scope FIND, byte-identical to find_workspace_entry_candidates BUT scope='worker'.
-- The owner narrowing rides $scope_pathname (Run.find folds the owner into the prefix glob —
-- `/<owner>/*`), so a worker reaches only its own (self) or a named sister's scratch. Additive: the
-- workspace query above is untouched (§worker-scheme Inc-1).
SELECT e.id AS entry_id, e.pathname, ec.content, ec.mimetype
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = $channel
WHERE e.scope = 'worker'
  AND e.workspace_id = $workspace_id
  AND e.scheme IS $scheme
  AND ($scope_pathname IS NULL OR e.pathname GLOB $scope_pathname)
  AND (
    json_array_length(COALESCE($tags, '[]')) = 0
    OR e.id IN (
        SELECT entry_id FROM entry_tags
        WHERE tag IN (SELECT value FROM json_each(COALESCE($tags, '[]')))
        GROUP BY entry_id
        HAVING COUNT(DISTINCT tag) = json_array_length(COALESCE($tags, '[]'))
    )
  )
ORDER BY e.pathname;
