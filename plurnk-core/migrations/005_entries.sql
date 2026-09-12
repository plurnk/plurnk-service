-- MIGRATE: 5 entries
-- Chapter 5 of the schema baseline ({§db-schema-baseline}): Entries and their channels, derivations and the search artifacts over them, native content.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- derivations
-- Content-addressed deep projections. Entry channels and log projections point
-- at a COMPLETE artifact by deep_hash; graph and FTS are stored once
-- regardless of how many addresses carry identical content under the same reader/config.
-- A building row is unattached and safely replaceable after interruption.
CREATE TABLE IF NOT EXISTS derivations (
    id          INTEGER NOT NULL PRIMARY KEY,
    deep_hash   TEXT    NOT NULL UNIQUE CHECK (length(deep_hash) > 0),
    state       TEXT    NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'complete')),
    disposition TEXT    CHECK (disposition IN ('indexed', 'excluded', 'unsearchable', 'failed')),
    reason      TEXT,
    parse_issues INTEGER CHECK (parse_issues IS NULL OR parse_issues > 0),
    summary     TEXT    CHECK (
        summary IS NULL OR (
            length(summary) > 0
            AND summary = trim(summary)
            AND instr(summary, char(10)) = 0
            AND instr(summary, char(13)) = 0
        )
    ),
    CHECK ((state = 'building' AND disposition IS NULL) OR (state = 'complete' AND disposition IS NOT NULL))
) STRICT;

-- entries
-- {§entry-identity-no-null} A resource belongs directly to its workspace.
-- Actor attribution and subscriptions do not participate in its address.
CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER NOT NULL PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    scheme     TEXT    NOT NULL             CHECK (length(scheme) > 0),
    -- Canonical resource authority; namespace schemes fold it into pathname.
    authority  TEXT    NOT NULL DEFAULT '',
    pathname   TEXT    NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Entry-private metadata. Prompt frames use `openPaths` to carry selected
    -- workspace paths into the exact turn that publishes the frame
    -- ({§methods-loop-run-open-paths}).
    attributes TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
    default_channel TEXT NOT NULL DEFAULT 'body' CHECK (length(default_channel) > 0),
    output INTEGER NOT NULL DEFAULT 0 CHECK (output IN (0, 1)),
    -- SPEC {§membership} — how a file member entered the curated surface. 'git' rows are
    -- reconciled against the repo's members each turn — tracked ls-files PLUS untracked-
    -- but-not-ignored files ({§membership-auto-add}) — registered + un-registered so entries
    -- == members; 'constraint' rows are reconciled from ordinary pick policy.
    -- NULL = not a file member (other schemes don't carry origin).
    membership_origin TEXT                   CHECK (membership_origin IS NULL OR membership_origin IN ('git', 'constraint')),
    -- SPEC {§membership-change-gated-sync} — the per-member sync stat-detect:
    -- "<mtimeMs>:<size>" of the disk file at its last materialization, or `absent`
    -- after an observed deletion. The pre-turn
    -- sync stat()s every member but re-reads/re-tokenizes/rewrites only one whose
    -- signature changed; an unchanged member is a no-op. NULL = never synced.
    synced_sig TEXT,
    -- User Note 5 — manifest cache-friendliness. Last-modified stamp, bumped on every
    -- addressable representation change; engine_list_workspace_entries orders the catalog
    -- by it ASC so dormant entries hold the stable prompt-cache prefix. Private derivation
    -- attachment does not make an entry recently touched.
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- {§entry-owner}, {§execution-output-identity}: one canonical resource key.
CREATE UNIQUE INDEX IF NOT EXISTS entries_identity ON entries (workspace_id, scheme, authority, pathname);

-- The ONE engine-imposed constraint (SPEC {§stream-constraints}, {§stream-constraints-engine-one-cap}): 100 MiB char-length cap
-- per channel content body. All other limits are extrinsic.
CREATE TABLE IF NOT EXISTS entry_channels (
    entry_id INTEGER NOT NULL,
    name     TEXT    NOT NULL             CHECK (length(name) > 0),
    content  TEXT    NOT NULL             CHECK (length(content) <= 104857600),
    mimetype TEXT    NOT NULL             CHECK (length(mimetype) > 0),
    weight   INTEGER NOT NULL DEFAULT 0   CHECK (weight >= 0),
    -- Content identity: sha256 of content, stamped at static writes; streamed
    -- appends leave it NULL. Curation weight remains model-independent.
    content_hash TEXT,
    -- Search derivation for this exact addressable channel representation.
    -- Content or mimetype changes invalidate it at the owning channel row.
    deep_hash TEXT,
    state    TEXT    NOT NULL DEFAULT 'static' CHECK (state IN ('static', 'active', 'closed', 'errored')),
    -- Exact terminal producer evidence for this representation channel. NULL is
    -- the ordinary implicit {status:200}; selection/projection metadata belongs
    -- to core and is never stored here.
    producer_result TEXT,
    CONSTRAINT entry_channel_producer_result_contract CHECK (
        CASE
            WHEN producer_result IS NULL THEN 1
            WHEN NOT json_valid(producer_result) THEN 0
            ELSE
                json_type(producer_result) IS 'object'
                AND json_type(producer_result, '$.status') IS 'integer'
                AND json_extract(producer_result, '$.status') BETWEEN 200 AND 599
                AND json_extract(producer_result, '$.status') != 202
                AND CASE
                    WHEN json_extract(producer_result, '$.status') < 400 THEN
                        json_type(producer_result, '$.problem') IS NULL
                    ELSE
                        json_type(producer_result, '$.problem') IS 'object'
                        AND json_type(producer_result, '$.problem.status') IS 'integer'
                        AND json_extract(producer_result, '$.problem.status')
                            = json_extract(producer_result, '$.status')
                        AND json_type(producer_result, '$.problem.type') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.type')) > 0
                        AND json_type(producer_result, '$.problem.title') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.title')) > 0
                        AND json_type(producer_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(producer_result, '$.problem.detail')) > 0
                END
        END
    ),
    PRIMARY KEY (entry_id, name),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (deep_hash) REFERENCES derivations(deep_hash)
) STRICT, WITHOUT ROWID;

-- {§db-fk-indexes} Derivation replacement checks channels by hash; catalog joins drive on it too.
CREATE INDEX IF NOT EXISTS entry_channels_deep_hash ON entry_channels (deep_hash) WHERE deep_hash IS NOT NULL;

-- {§crud} A publication is one SQL statement: failure rolls back metadata and
-- every channel. The view is an input boundary, not a second persisted copy.
CREATE VIEW IF NOT EXISTS entry_publication AS
SELECT NULL AS workspace_id, NULL AS scheme, NULL AS authority, NULL AS pathname,
       NULL AS attributes, NULL AS default_channel, NULL AS output,
       NULL AS channels, NULL AS created
WHERE 0;

CREATE TRIGGER IF NOT EXISTS entry_publication_insert
INSTEAD OF INSERT ON entry_publication
BEGIN
    SELECT CASE WHEN json_type(NEW.channels) IS NOT 'object'
        THEN RAISE(ABORT, 'entry publication requires a channel object') END;
    INSERT INTO entries (workspace_id, scheme, authority, pathname, attributes, default_channel, output)
    VALUES (NEW.workspace_id, NEW.scheme, NEW.authority, NEW.pathname,
            COALESCE(NEW.attributes, '{}'), NEW.default_channel, NEW.output)
    ON CONFLICT (workspace_id, scheme, authority, pathname) DO UPDATE SET
        attributes = COALESCE(NEW.attributes, entries.attributes),
        default_channel = excluded.default_channel,
        output = MAX(entries.output, excluded.output);
    DELETE FROM entry_channels WHERE entry_id = (
        SELECT id FROM entries WHERE workspace_id = NEW.workspace_id
          AND scheme = NEW.scheme AND authority = NEW.authority AND pathname = NEW.pathname
    );
    INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, state, producer_result)
    SELECT e.id, c.key, json_extract(c.value, '$.content'), json_extract(c.value, '$.mimetype'),
           json_extract(c.value, '$.weight'), json_extract(c.value, '$.content_hash'),
           json_extract(c.value, '$.state'), json_extract(c.value, '$.producer_result')
    FROM entries e, json_each(NEW.channels) c
    WHERE e.workspace_id = NEW.workspace_id AND e.scheme = NEW.scheme
      AND e.authority = NEW.authority AND e.pathname = NEW.pathname;
END;

-- symbol_defs
-- &graph NODES ({§relation-indexed-dialects}). Code symbol definitions, populated
-- once per content-addressed derivation from mimetypes'
-- `symbols` channel. Qualified path = container ? container || '.' || name : name.
CREATE TABLE IF NOT EXISTS symbol_defs (
    id         INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    end_line   INTEGER,
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_defs_name   ON symbol_defs (name);

-- {§db-fk-indexes} Reindexing deletes a derivation's definitions by derivation; mirrors symbol_refs_source.
CREATE INDEX IF NOT EXISTS symbol_defs_source ON symbol_defs (derivation_id);

-- symbol_refs
-- &graph EDGES ({§relation-indexed-dialects}), from mimetypes' `references` channel.
-- name = edge TARGET; container = the SOURCE def's full qualified path (the
-- &> join key; module-level → NULL); kind ∈ import|call|instantiate|inherit|
-- type|use (frozen, edge metadata only — traversal is kind-agnostic).
CREATE TABLE IF NOT EXISTS symbol_refs (
    id         INTEGER NOT NULL PRIMARY KEY,
    derivation_id INTEGER NOT NULL,
    name       TEXT    NOT NULL CHECK (length(name) > 0),
    kind       TEXT    NOT NULL,
    container  TEXT,
    line       INTEGER NOT NULL,
    FOREIGN KEY (derivation_id) REFERENCES derivations(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS symbol_refs_name   ON symbol_refs (name);

CREATE INDEX IF NOT EXISTS symbol_refs_source ON symbol_refs (derivation_id, container);

-- {§find-fulltext-selection} Native full-text index of the addressed READ body.
-- rowid is the content-addressed derivation id.
CREATE VIRTUAL TABLE IF NOT EXISTS derivation_fts USING fts5(content);

-- {§packet-attachment-parts}: READ snapshots survive source changes and log curation.
CREATE TABLE IF NOT EXISTS native_contents (
    hash TEXT NOT NULL PRIMARY KEY CHECK (length(hash) = 64),
    content BLOB NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS native_contents_immutable
BEFORE UPDATE ON native_contents
BEGIN
    SELECT RAISE(ABORT, 'native content is immutable');
END;
