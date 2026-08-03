-- Automatic worker allocation. SPEC {§worker-auto-name}.

-- PREP: worker_name_count
-- A starting hint only. The atomic claim below remains authoritative because
-- explicit names and concurrent allocators can occupy any candidate.
SELECT COUNT(*) AS n
FROM workers
WHERE workspace_id = $workspace_id AND name LIKE $name_prefix;

-- PREP: worker_name_claim
-- Claiming the literal and creating its worker are one SQLite write statement.
-- The root predicate is enabled only by ensureAutoRoot; ordinary allocation
-- passes NULL and competes solely on the generated literal.
INSERT INTO workers (workspace_id, name, parent_worker_id, origin)
SELECT $workspace_id, $name, $parent_worker_id, $origin
WHERE NOT EXISTS (
    SELECT 1
    FROM workers
    WHERE workspace_id = $workspace_id AND name = $name
)
AND (
    $root_origin IS NULL OR NOT EXISTS (
        SELECT 1
        FROM workers
        WHERE workspace_id = $workspace_id
          AND origin = $root_origin
          AND parent_worker_id IS NULL
    )
)
RETURNING id, name;

-- PREP: worker_name_get_root
SELECT id, name
FROM workers
WHERE workspace_id = $workspace_id
  AND origin = $origin
  AND parent_worker_id IS NULL
ORDER BY id
LIMIT 1;
