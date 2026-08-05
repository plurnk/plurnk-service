-- Automatic worker allocation. SPEC {§worker-auto-name}.

-- PREP: worker_name_count
-- A starting hint only. The atomic claim below remains authoritative because
-- explicit names and concurrent allocators can occupy any candidate.
SELECT COUNT(*) AS n
FROM workers
WHERE workspace_id = $workspace_id AND name LIKE $name_prefix;

-- PREP: worker_name_claim
-- Claiming the literal and creating its worker are one SQLite write statement.
-- The default-conversation predicate is enabled only by
-- ensureDefaultConversation; ordinary allocation passes 0 and competes solely
-- on the generated literal.
INSERT INTO workers (workspace_id, name, parent_worker_id, origin, default_conversation)
SELECT $workspace_id, $name, $parent_worker_id, $origin, $default_conversation
WHERE NOT EXISTS (
    SELECT 1
    FROM workers
    WHERE workspace_id = $workspace_id AND name = $name
)
AND (
    $default_conversation = 0 OR NOT EXISTS (
        SELECT 1
        FROM workers
        WHERE workspace_id = $workspace_id
          AND default_conversation = 1
    )
)
RETURNING id, name;

-- PREP: worker_name_get_default_conversation
SELECT id, name
FROM workers
WHERE workspace_id = $workspace_id
  AND default_conversation = 1;
