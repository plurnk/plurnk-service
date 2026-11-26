-- {§model-catalog-build} {§model-catalog-cache} — Schema and write statements for shipped
-- catalog.db and cached models.db snapshots (#1576).

-- INIT: catalog_schema
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE providers (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    adapter TEXT NOT NULL,
    env     TEXT NOT NULL CHECK (json_valid(env)),
    api     TEXT
) STRICT;

CREATE TABLE models (
    provider_id       TEXT    NOT NULL REFERENCES providers(id),
    id                TEXT    NOT NULL,
    suffix            TEXT,
    name              TEXT    NOT NULL,
    context_window    INTEGER NOT NULL CHECK (context_window > 0),
    max_input_tokens  INTEGER,
    max_output_tokens INTEGER,
    attachment        INTEGER NOT NULL CHECK (attachment IN (0, 1)),
    reasoning         INTEGER NOT NULL CHECK (reasoning IN (0, 1)),
    reasoning_options TEXT    CHECK (reasoning_options IS NULL OR json_valid(reasoning_options)),
    tool_call         INTEGER NOT NULL CHECK (tool_call IN (0, 1)),
    structured_output INTEGER CHECK (structured_output IS NULL OR structured_output IN (0, 1)),
    temperature       INTEGER CHECK (temperature IS NULL OR temperature IN (0, 1)),
    modalities_input  TEXT    NOT NULL CHECK (json_valid(modalities_input)),
    modalities_output TEXT    NOT NULL CHECK (json_valid(modalities_output)),
    cost_input        REAL,
    cost_output       REAL,
    cost_reasoning    REAL,
    cost_cache_read   REAL,
    cost_cache_write  REAL,
    PRIMARY KEY (provider_id, id)
) STRICT;

CREATE INDEX idx_models_provider_suffix ON models (provider_id, suffix);
CREATE INDEX idx_models_selector ON models (provider_id || '/' || id);

-- EXEC: catalog_begin
BEGIN;

-- EXEC: catalog_commit
COMMIT;

-- EXEC: catalog_rollback
ROLLBACK;

-- PREP: catalog_put_meta
INSERT OR REPLACE INTO meta (key, value) VALUES ($key, $value);

-- PREP: catalog_put_provider
INSERT INTO providers (id, name, adapter, env, api)
VALUES ($id, $name, $adapter, $env, $api);

-- PREP: catalog_put_model
INSERT INTO models (
    provider_id,
    id,
    suffix,
    name,
    context_window,
    max_input_tokens,
    max_output_tokens,
    attachment,
    reasoning,
    reasoning_options,
    tool_call,
    structured_output,
    temperature,
    modalities_input,
    modalities_output,
    cost_input,
    cost_output,
    cost_reasoning,
    cost_cache_read,
    cost_cache_write
) VALUES (
    $provider_id,
    $id,
    $suffix,
    $name,
    $context_window,
    $max_input_tokens,
    $max_output_tokens,
    $attachment,
    $reasoning,
    $reasoning_options,
    $tool_call,
    $structured_output,
    $temperature,
    $modalities_input,
    $modalities_output,
    $cost_input,
    $cost_output,
    $cost_reasoning,
    $cost_cache_read,
    $cost_cache_write
);

-- EXEC: catalog_seal
PRAGMA journal_mode = DELETE;
VACUUM;
PRAGMA optimize;
