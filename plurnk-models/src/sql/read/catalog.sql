-- {§model-catalog-projection} {§model-catalog-cache} — Read-only queries over catalog.db or an
-- attached overlay view. Zero INIT/MIGRATE blocks so opening immutable 0444 databases never writes (#1576).

-- PREP: catalog_get_meta
SELECT value FROM meta WHERE key = $key;

-- PREP: catalog_lookup_provider
SELECT id, name, adapter, env, api FROM providers WHERE id = $id;

-- PREP: catalog_list_providers
SELECT id, name, adapter, env, api FROM providers ORDER BY id;

-- PREP: catalog_list_populated_providers
SELECT p.id, p.name, p.adapter, p.env, p.api
FROM providers p
WHERE EXISTS (SELECT 1 FROM models m WHERE m.provider_id = p.id)
ORDER BY p.id;

-- PREP: catalog_list_provider_envs
SELECT env FROM providers;

-- PREP: catalog_lookup_model
SELECT * FROM models WHERE provider_id = $provider_id AND id = $id;

-- PREP: catalog_resolve_leaf_suffix
SELECT * FROM models
WHERE provider_id = $provider_id AND suffix = $suffix
LIMIT 2;

-- PREP: catalog_resolve_path_suffix
SELECT * FROM models
WHERE provider_id = $provider_id
  AND length(id) >= length($slash_suffix)
  AND substr(id, length(id) - length($slash_suffix) + 1) = $slash_suffix
LIMIT 2;

-- PREP: catalog_list_models
SELECT * FROM models ORDER BY provider_id, id;

-- PREP: catalog_count_providers
SELECT COUNT(*) AS n FROM (SELECT DISTINCT provider_id FROM models);

-- PREP: catalog_count_models
SELECT COUNT(*) AS n FROM models;

-- PREP: catalog_query_models
SELECT m.*,
       p.name AS provider_name,
       p.adapter AS provider_adapter,
       p.env AS provider_env,
       p.api AS provider_api
FROM models m
JOIN providers p ON p.id = m.provider_id
WHERE m.provider_id IN (SELECT value FROM json_each($providers))
  AND (
      $search = ''
      OR instr(lower(m.provider_id || '/' || m.id), $search) > 0
      OR instr(lower(p.name), $search) > 0
      OR instr(lower(m.name), $search) > 0
  )
  AND (
      $min_input_cost IS NULL
      OR (m.cost_input IS NOT NULL AND m.cost_output IS NOT NULL AND m.cost_input >= $min_input_cost)
  )
  AND (
      $max_input_cost IS NULL
      OR (m.cost_input IS NOT NULL AND m.cost_output IS NOT NULL AND m.cost_input <= $max_input_cost)
  )
ORDER BY
  CASE WHEN $sort IN ('cost-asc', 'cost-desc') THEN (m.cost_input IS NULL OR m.cost_output IS NULL) ELSE 0 END ASC,
  CASE WHEN $sort = 'cost-asc' THEN m.cost_input END ASC,
  CASE WHEN $sort = 'cost-asc' THEN m.cost_output END ASC,
  CASE WHEN $sort = 'cost-desc' THEN m.cost_input END DESC,
  CASE WHEN $sort = 'cost-desc' THEN m.cost_output END DESC,
  CASE WHEN $sort = 'context-desc' THEN m.context_window END DESC,
  (m.provider_id || '/' || m.id) COLLATE BINARY ASC
LIMIT $limit OFFSET $offset;

-- PREP: catalog_query_models_count
SELECT COUNT(*) AS total
FROM models m
JOIN providers p ON p.id = m.provider_id
WHERE m.provider_id IN (SELECT value FROM json_each($providers))
  AND (
      $search = ''
      OR instr(lower(m.provider_id || '/' || m.id), $search) > 0
      OR instr(lower(p.name), $search) > 0
      OR instr(lower(m.name), $search) > 0
  )
  AND (
      $min_input_cost IS NULL
      OR (m.cost_input IS NOT NULL AND m.cost_output IS NOT NULL AND m.cost_input >= $min_input_cost)
  )
  AND (
      $max_input_cost IS NULL
      OR (m.cost_input IS NOT NULL AND m.cost_output IS NOT NULL AND m.cost_input <= $max_input_cost)
  );
