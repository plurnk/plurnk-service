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
ORDER BY (m.provider_id || '/' || m.id) COLLATE BINARY
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
  );
