-- MIGRATE: 1 workspaces
-- Chapter 1 of the schema baseline ({§db-schema-baseline}): The workspace: identity, module state, membership constraints.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- workspaces
-- project_root: workspace pointer. NULL = headless (no disk side-effects);
-- non-null = absolute path to the client's source tree, supplied at
-- workspace.create or workspace.set_root.
CREATE TABLE IF NOT EXISTS workspaces (
    id                        INTEGER NOT NULL PRIMARY KEY,
    version                   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name                      TEXT    NOT NULL UNIQUE CHECK (length(name) > 0),
    created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    project_root              TEXT,
    -- {§operator-config} validated client workspace settings; each field composes
    -- with operator configuration at its owning use site.
    settings                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
) STRICT;

CREATE INDEX IF NOT EXISTS workspaces_created_at ON workspaces (created_at);

-- {§module-workspace-state}: one provider-validated snapshot per workspace.
CREATE TABLE IF NOT EXISTS workspace_module_state (
    workspace_id      INTEGER NOT NULL,
    namespace_owner  TEXT    NOT NULL CHECK (length(namespace_owner) > 0),
    state             TEXT    NOT NULL CHECK (json_valid(state)),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, namespace_owner),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

-- workspace_constraints
-- SPEC {§membership} constraint overlay — explicit policy and the inspectable
-- exact pick produced by accepted file creation share one representation.
-- Per (workspace, effect, glob/target): `pick` (members git misses, resolved by a
-- targeted client-dictated scan), `hide` (drop git-tracked matches), `view` (member
-- for read; File.edit rejects the write). git-absent, `pick` rows are the sole substrate
-- source. Composed at membership resolution; node:path.matchesGlob.
CREATE TABLE IF NOT EXISTS workspace_constraints (
    workspace_id INTEGER NOT NULL,
    -- include admits files git misses; exclude removes members — the members family's lexicon
    -- ({§members-projection}). An inclusion is a pattern scan; a creation record is one exact path.
    effect     TEXT    NOT NULL CHECK (effect IN ('include', 'exclude')),
    glob       TEXT    NOT NULL,
    -- create: the exact record of a file Plurnk wrote ({§fs-create-record}); members: a
    -- human-authored definition projected by the members family; model: a definition the model
    -- proposed under the members scope — never admitted past the repository's ignore rules.
    source     TEXT    NOT NULL CHECK (source IN ('create', 'members', 'model')),
    CHECK (source IN ('members', 'model') OR effect = 'include'),
    PRIMARY KEY (workspace_id, effect, glob),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
