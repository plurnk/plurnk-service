-- {§model-catalog-cache} — Read-only ATTACH + TEMP VIEW overlay unifying primary (newer) and
-- secondary catalog databases without materializing either catalog in Node heap (#1576).

-- INIT: catalog_attach_overlay
ATTACH DATABASE $primary_uri AS primary_cat;
ATTACH DATABASE $secondary_uri AS secondary_cat;

CREATE TEMP VIEW meta AS
SELECT key, value FROM primary_cat.meta;

CREATE TEMP VIEW providers AS
SELECT id, name, adapter, env, api FROM primary_cat.providers
UNION ALL
SELECT s.id, s.name, s.adapter, s.env, s.api
FROM secondary_cat.providers s
WHERE NOT EXISTS (
    SELECT 1 FROM primary_cat.providers p WHERE p.id = s.id
);

CREATE TEMP VIEW models AS
SELECT * FROM primary_cat.models
UNION ALL
SELECT s.*
FROM secondary_cat.models s
WHERE NOT EXISTS (
    SELECT 1 FROM primary_cat.models p
    WHERE p.provider_id = s.provider_id AND p.id = s.id
);
