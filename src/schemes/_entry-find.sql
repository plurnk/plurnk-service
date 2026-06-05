-- FIND helper for entry-bearing schemes (SPEC §6.6).
-- Static query handles all filter combinations via IS-NULL guards
-- (per SqlRite LLMS.md §5) and json_each over a JSON tag array.

-- PREP: find_session_entries
-- $scope_pathname: pathname-prefix glob (e.g., "foo/*") or NULL for no prefix
-- $pathname_pattern: full glob pattern or NULL for no glob filter
-- $pathname_regex: regex (optional leading (?flags) from imsuv) or NULL for no regex filter
-- $tags: JSON string of tag list (e.g., '["a","b"]'); '[]' or NULL for no tag filter
SELECT e.pathname
FROM entries e
WHERE e.scope = 'session'
  AND e.session_id = $session_id
  AND e.scheme = $scheme
  AND ($scope_pathname IS NULL OR e.pathname GLOB $scope_pathname)
  AND ($pathname_pattern IS NULL OR e.pathname GLOB $pathname_pattern)
  AND ($pathname_regex IS NULL OR e.pathname REGEXP $pathname_regex)
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
