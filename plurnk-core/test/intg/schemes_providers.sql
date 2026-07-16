-- PREP: test_sp_table_sql
SELECT sql FROM sqlite_master WHERE name = $name;

-- PREP: test_schemes_register
INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, handler)
VALUES ($name, 1, 'knowledge', 'workspace', 'body', $writable_by, 0, NULL);

-- PREP: test_schemes_get
SELECT name, model_visible, category, default_scope, default_channel, channel_orientations, writable_by, volatile, handler
FROM schemes WHERE name = $name;

-- PREP: test_schemes_insert_full
INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile)
VALUES ($name, $model_visible, $category, $default_scope, $default_channel, $writable_by, $volatile);

-- PREP: test_schemes_insert_with_orient
INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, channel_orientations)
VALUES ($name, $model_visible, $category, $default_scope, $default_channel, $writable_by, $volatile, $orient);

-- PREP: test_schemes_insert_with_handler
INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, handler)
VALUES ($name, $model_visible, $category, $default_scope, $default_channel, $writable_by, $volatile, $handler);

-- PREP: test_schemes_list_handlers
SELECT name, handler FROM schemes ORDER BY name;

-- PREP: test_providers_insert
INSERT INTO providers (provider, family, model, contextSize, currency)
VALUES ($provider, $family, $model, $contextSize, $currency);

-- PREP: test_providers_get
SELECT id, version, provider, family, model, contextSize, currency, created_at
FROM providers WHERE model = $model;

-- PREP: test_providers_count
SELECT COUNT(*) AS n FROM providers WHERE model = $model;

-- PREP: test_providers_list_ids
SELECT id FROM providers ORDER BY id;

-- PREP: test_providers_index
SELECT name FROM sqlite_master WHERE type='index' AND name='providers_created_at';
