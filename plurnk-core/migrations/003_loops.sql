-- MIGRATE: 3 loops
-- Chapter 3 of the schema baseline ({§db-schema-baseline}): Loops, their turns, and the immutable sources a turn was built from.
-- Version numbers order the chapters on a fresh database; they are not history. A shape
-- change edits the chapter in place; existing development databases are recreated.

-- loops
-- policy: immutable per-loop proposal disposition ({§loop-policy-effective-read}).
CREATE TABLE IF NOT EXISTS loops (
    id       INTEGER NOT NULL PRIMARY KEY,
    version  INTEGER NOT NULL DEFAULT 0   CHECK (version >= 0),
    worker_id   INTEGER NOT NULL,
    sequence INTEGER NOT NULL             CHECK (sequence >= 1),
    status   INTEGER NOT NULL DEFAULT 102 CHECK (status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508)),
    prompt   TEXT    NOT NULL,
    -- {§prompt-causal-source}: canonical actor address for the initial prompt;
    -- NULL means the owning worker itself.
    prompt_source TEXT CHECK (prompt_source IS NULL OR length(prompt_source) > 0),
    policy   TEXT    NOT NULL DEFAULT '{"proposals":"review"}' CHECK (json_valid(policy)),
    -- {§worker-model-selection}: immutable loop snapshots of the resolved model route and the
    -- effective spawn route (was provider_spec/child_provider_spec JSON).
    model_route_id       INTEGER          REFERENCES model_routes(id),
    spawn_model_route_id INTEGER          REFERENCES model_routes(id),
    reasoning_policy TEXT CHECK (reasoning_policy IS NULL OR length(reasoning_policy) > 0),
    max_turns INTEGER NOT NULL DEFAULT 50 CHECK (max_turns >= -1),
    -- {§worker-scheduled-send}: the selected cadence slot, coalesced at claim.
    scheduled_at INTEGER CHECK (scheduled_at IS NULL OR scheduled_at BETWEEN 0 AND 8640000000000000),
    repeat_interval_ms INTEGER CHECK (repeat_interval_ms IS NULL OR repeat_interval_ms > 0),
    recurrence_root_loop_id INTEGER REFERENCES loops(id),
    -- {§loop-execution-allowance}: initialized on first execution, charged with disposition.
    execution_budget_ms INTEGER CHECK (execution_budget_ms IS NULL OR execution_budget_ms > 0),
    execution_elapsed_ms REAL NOT NULL DEFAULT 0 CHECK (execution_elapsed_ms >= 0),
    -- {§worker-wait-timing}: epoch milliseconds; NULL polling inherits streams.
    wait_revision INTEGER NOT NULL DEFAULT 0 CHECK (wait_revision >= 0),
    -- {§loop-rail-continuity}: one loop-owned streak and bounded repetition window.
    strike_streak INTEGER NOT NULL DEFAULT 0 CHECK (strike_streak >= 0),
    cycle_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cycle_history) AND json_type(cycle_history) = 'array'),
    cycle_wait_revision INTEGER NOT NULL DEFAULT 0 CHECK (cycle_wait_revision >= 0 AND cycle_wait_revision <= wait_revision),
    observed_wake_revision INTEGER NOT NULL DEFAULT 0 CHECK (observed_wake_revision >= 0),
    wait_deadline_at INTEGER,
    wait_poll_interval INTEGER CHECK (wait_poll_interval IS NULL OR wait_poll_interval >= 0),
    wait_poll_at INTEGER,
    -- {§methods-loop-run-open-paths}: the initial prompt frame's selected paths,
    -- held here until turn 1 materializes that frame (string[] JSON).
    open_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_paths)),
    -- {§prompt-loop-containment}: one queued recovery loop may carry the
    -- complete orphan frame set of one concluded source loop.
    orphan_source_loop_id INTEGER,
    -- {§worker-scheme} loop-termination delta: terminated_at is stamped by the trigger
    -- below when status crosses into terminal (every death-path, uniformly).
    terminated_at    TEXT,
    terminal_result  TEXT,
    -- {§loop-terminal-authorship}: 'cancel' names an external loop.cancel;
    -- NULL covers model terminals and engine verdicts whose result carries the story.
    terminated_by    TEXT                      CHECK (terminated_by IS NULL OR terminated_by = 'cancel'),
    CONSTRAINT loops_generation_policy_contract CHECK (
        (model_route_id IS NULL) = (reasoning_policy IS NULL)
    ),
    CONSTRAINT loops_schedule_contract CHECK (
        (repeat_interval_ms IS NULL OR scheduled_at IS NOT NULL)
        AND (recurrence_root_loop_id IS NULL OR repeat_interval_ms IS NOT NULL)
    ),
    CONSTRAINT loops_terminal_result_contract CHECK (
        CASE
            WHEN status IN (100, 102, 202) THEN terminal_result IS NULL
            WHEN terminal_result IS NULL OR NOT json_valid(terminal_result) THEN 0
            ELSE
                json_type(terminal_result) IS 'object'
                AND json_type(terminal_result, '$.status') IS 'integer'
                AND (
                    json_extract(terminal_result, '$.status') = status
                    OR (
                        status = 200
                        AND json_extract(terminal_result, '$.status') BETWEEN 200 AND 399
                        AND json_extract(terminal_result, '$.status') != 202
                    )
                    OR (
                        status = 500
                        AND json_extract(terminal_result, '$.status') BETWEEN 400 AND 599
                    )
                )
                AND CASE
                    WHEN json_extract(terminal_result, '$.status') < 400 THEN
                        json_type(terminal_result, '$.problem') IS NULL
                    ELSE
                        json_type(terminal_result, '$.problem') IS 'object'
                        AND json_type(terminal_result, '$.problem.status') IS 'integer'
                        AND json_extract(terminal_result, '$.problem.status')
                            = json_extract(terminal_result, '$.status')
                        AND json_type(terminal_result, '$.problem.type') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.type')) > 0
                        AND json_type(terminal_result, '$.problem.title') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.title')) > 0
                        AND json_type(terminal_result, '$.problem.detail') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.detail')) > 0
                        AND json_type(terminal_result, '$.problem.instance') IS 'text'
                        AND length(json_extract(terminal_result, '$.problem.instance')) > 0
                END
        END
    ),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (orphan_source_loop_id) REFERENCES loops(id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS loops_worker_id_sequence ON loops (worker_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS loops_orphan_source_loop_id ON loops (orphan_source_loop_id);

-- {§db-fk-indexes} Foreign-key check paths (route replacement, recurrence-root cascade) stop scanning loops.
CREATE INDEX IF NOT EXISTS loops_model_route_id         ON loops (model_route_id)         WHERE model_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS loops_spawn_model_route_id   ON loops (spawn_model_route_id)   WHERE spawn_model_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS loops_recurrence_root_loop_id ON loops (recurrence_root_loop_id) WHERE recurrence_root_loop_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loops_live_recurrence
ON loops (COALESCE(recurrence_root_loop_id, id))
WHERE repeat_interval_ms IS NOT NULL AND status IN (100, 102, 202);

-- turns
-- finish_reason / model: accepted provider-call metadata from the provider
-- response contract. Physical request accounting is normalized beneath the
-- logical emission attempt that caused it.
CREATE TABLE IF NOT EXISTS turns (
    id               INTEGER NOT NULL PRIMARY KEY,
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    loop_id          INTEGER NOT NULL,
    sequence         INTEGER NOT NULL           CHECK (sequence >= 1),
    timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- {§turn-record}: producer and purpose define the turn. Packet/provider
    -- evidence below is an optional inference specialization.
    producer         TEXT    NOT NULL           CHECK (producer IN ('model', 'client', '_plurnk', 'plugin')),
    kind             TEXT    NOT NULL           CHECK (kind IN ('inference', 'initialization', 'operation', 'maintenance')),
    status           INTEGER NOT NULL           CHECK (status BETWEEN 100 AND 599),
    -- NULL while the producer still owns this turn. Status 102 is both the
    -- provisional running value and the exact completed continue disposition;
    -- completed_at distinguishes those states without inventing another status.
    completed_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Provider-derived curation calibration for this turn; NULL when input
    -- capacity is unknown. {§tokenomics-client-gauge}
    usage_curation_budget INTEGER                CHECK (usage_curation_budget IS NULL OR usage_curation_budget >= 1),
    -- {§packet-stored-shape}: NULL means no model request was assembled. A
    -- present packet is either the measured request or that request extended
    -- by the paired admitted-response fields. Its sections are rows
    -- ({§packet-items}), never in this bag: the bag holds weight, attributions,
    -- attachments, and the admitted response.
    packet           TEXT                       CHECK (
        CASE
            WHEN packet IS NULL THEN 1
            WHEN json_valid(packet) = 0 THEN 0
            ELSE COALESCE(
                json_type(packet) = 'object'
                AND json_type(packet, '$.weight') = 'integer'
                AND json_extract(packet, '$.weight') >= 0
                AND json_type(packet, '$.sections') IS NULL
                AND json_type(packet, '$.attributions') = 'array'
                AND (
                    (
                        json_type(packet, '$.assistant') IS NULL
                        AND json_type(packet, '$.assistantRaw') IS NULL
                    )
                    OR (
                        json_type(packet, '$.assistant') = 'object'
                        AND json_type(packet, '$.assistant.content') = 'text'
                        AND json_type(packet, '$.assistant.ops') = 'array'
                        AND json_type(packet, '$.assistant.reasoning') IN ('text', 'null')
                        AND json_type(packet, '$.assistantRaw') IS NOT NULL
                    )
                ),
                0
            )
        END
    ),
    finish_reason    TEXT,
    model            TEXT                       CHECK (model IS NULL OR length(model) >= 1),
    -- Opaque provider→client metadata plus the grammar transport key; absent outside
    -- recorded inference evidence. {§meta-passthrough}, {§operator-grammar}
    meta             TEXT                       CHECK (meta IS NULL OR json_valid(meta)),
    CHECK (completed_at IS NOT NULL OR status = 102),
    CHECK ((producer = 'model') = (kind = 'inference')),
    CHECK (kind NOT IN ('initialization', 'maintenance') OR producer = '_plurnk'),
    CHECK (
        kind = 'inference'
        OR (
            usage_curation_budget IS NULL
            AND packet IS NULL
            AND finish_reason IS NULL
            AND model IS NULL
            AND meta IS NULL
        )
    ),
    FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS turns_loop_id_sequence ON turns (loop_id, sequence);

-- {§actor-boundary-doc-injection}: derived observation only; no durable row is rewritten.
CREATE VIEW IF NOT EXISTS work_loops AS
SELECT l.* FROM loops l
WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.loop_id = l.id AND t.kind = 'maintenance')
   OR EXISTS (SELECT 1 FROM turns t WHERE t.loop_id = l.id AND t.kind <> 'maintenance');

-- {§packet-items}: a packet's sections are rows over content-addressed items. Every rendered
-- block — one log row's record, one non-log section's content — is stored once by its hash;
-- a turn stores the ordered composition. A row whose rendering did not change between turns
-- hashes to the same item, so a turn's durable cost is its new and changed items.
CREATE TABLE IF NOT EXISTS packet_items (
    hash TEXT NOT NULL PRIMARY KEY CHECK (length(hash) = 64),
    text TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS turn_sections (
    turn_id  INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name     TEXT    NOT NULL CHECK (length(name) > 0),
    slot     TEXT    NOT NULL CHECK (slot IN ('system', 'user')),
    header   TEXT,
    weight   INTEGER NOT NULL CHECK (weight >= 0),
    PRIMARY KEY (turn_id, position),
    UNIQUE (turn_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS turn_section_items (
    turn_id   INTEGER NOT NULL,
    section   INTEGER NOT NULL,
    position  INTEGER NOT NULL CHECK (position >= 0),
    item_hash TEXT    NOT NULL REFERENCES packet_items(hash),
    PRIMARY KEY (turn_id, section, position),
    FOREIGN KEY (turn_id, section) REFERENCES turn_sections(turn_id, position) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- {§db-fk-indexes}: item collection and the packet_items foreign-key check path.
CREATE INDEX IF NOT EXISTS turn_section_items_item_hash ON turn_section_items (item_hash);

-- {§packet-items}: the one write of inference evidence — the packet bag, its sections as items,
-- and the provider metadata land in one statement through this view.
CREATE VIEW IF NOT EXISTS turn_inference_evidence AS
SELECT NULL AS turn_id, NULL AS packet, NULL AS sections,
       NULL AS usage_curation_budget, NULL AS finish_reason, NULL AS model, NULL AS meta
WHERE 0;

CREATE TRIGGER IF NOT EXISTS turn_inference_evidence_insert
INSTEAD OF INSERT ON turn_inference_evidence
BEGIN
    SELECT RAISE(ABORT, 'turn is not an open model inference turn')
    WHERE NOT EXISTS (
        SELECT 1 FROM turns
        WHERE id = NEW.turn_id AND producer = 'model' AND kind = 'inference'
          AND completed_at IS NULL AND packet IS NULL
    );
    SELECT RAISE(ABORT, 'packet sections must be a JSON array of {name, slot, header, weight, items}')
    WHERE json_type(NEW.sections) IS NOT 'array';
    INSERT OR IGNORE INTO packet_items (hash, text)
    SELECT sha256(item.value), item.value
    FROM json_each(NEW.sections) AS section, json_each(section.value, '$.items') AS item;
    INSERT INTO turn_sections (turn_id, position, name, slot, header, weight)
    SELECT NEW.turn_id, section.key,
           json_extract(section.value, '$.name'), json_extract(section.value, '$.slot'),
           json_extract(section.value, '$.header'), json_extract(section.value, '$.weight')
    FROM json_each(NEW.sections) AS section;
    INSERT INTO turn_section_items (turn_id, section, position, item_hash)
    SELECT NEW.turn_id, section.key, item.key, sha256(item.value)
    FROM json_each(NEW.sections) AS section, json_each(section.value, '$.items') AS item;
    UPDATE turns
    SET packet = NEW.packet,
        usage_curation_budget = NEW.usage_curation_budget,
        finish_reason = NEW.finish_reason,
        model = NEW.model,
        meta = NEW.meta
    WHERE id = NEW.turn_id;
END;

-- {§packet-items}: a turn as its readers know it — the packet bag with its sections assembled
-- back into it, byte for byte: a section's content is its items joined by one blank line.
CREATE VIEW IF NOT EXISTS turn_packets AS
SELECT t.id, t.loop_id, t.sequence, t.timestamp, t.producer, t.kind, t.status, t.completed_at,
       t.usage_curation_budget, t.finish_reason, t.model, t.meta, t.version,
       CASE WHEN t.packet IS NULL THEN NULL ELSE json_set(t.packet, '$.sections', json((
           SELECT COALESCE(json_group_array(json_object(
               'name', ts.name, 'slot', ts.slot, 'header', ts.header, 'weight', ts.weight,
               'content', COALESCE((
                   SELECT group_concat(pi.text, char(10) || char(10) ORDER BY tsi.position)
                   FROM turn_section_items tsi JOIN packet_items pi ON pi.hash = tsi.item_hash
                   WHERE tsi.turn_id = ts.turn_id AND tsi.section = ts.position
               ), '')
           ) ORDER BY ts.position), '[]')
           FROM turn_sections ts WHERE ts.turn_id = t.id
       ))) END AS packet
FROM turns t;

-- {§turn-source-resources}: immutable source facts belong to their turn, not
-- its curatable log. Derivation attachments are replaceable, source bytes are not.
CREATE TABLE IF NOT EXISTS turn_sources (
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ops', 'reasoning')),
    content TEXT NOT NULL,
    model_call_id INTEGER REFERENCES model_calls(id),
    deep_hash TEXT REFERENCES derivations(deep_hash),
    PRIMARY KEY (turn_id, kind)
) STRICT;

-- {§db-fk-indexes} A derivation replacement checks its referrers; the hash is indexed where it is a foreign key.
CREATE INDEX IF NOT EXISTS turn_sources_deep_hash ON turn_sources (deep_hash) WHERE deep_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS turn_sources_immutable
BEFORE UPDATE OF turn_id, kind, content, model_call_id ON turn_sources
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS turn_sources_delete_with_turn_only
BEFORE DELETE ON turn_sources
WHEN EXISTS (SELECT 1 FROM turns WHERE id = OLD.turn_id)
BEGIN
    SELECT RAISE(ABORT, 'turn source evidence belongs to its retained turn');
END;

-- {§turn-record} Producer and purpose never change beneath execution history.
CREATE TRIGGER IF NOT EXISTS turns_identity_forward_only
BEFORE UPDATE OF producer, kind ON turns
WHEN NOT (
    OLD.producer = NEW.producer
    AND OLD.kind = NEW.kind
)
BEGIN
    SELECT RAISE(ABORT, 'turn producer and kind are immutable');
END;
