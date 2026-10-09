-- MIGRATE: 21 packet roles
-- {§packet-wire-envelope} {§packet-items}: preserve every retained role, position and item.
-- Both sides of the section-membership foreign key are copied before either old table is
-- dropped. Foreign keys remain enabled; no dependent rows rely on surviving a parent DROP.
CREATE TABLE turn_sections_rebuilt (
    turn_id  INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name     TEXT    NOT NULL CHECK (length(name) > 0),
    slot     TEXT    NOT NULL CHECK (slot IN ('system', 'user', 'assistant')),
    header   TEXT,
    weight   INTEGER NOT NULL CHECK (weight >= 0),
    PRIMARY KEY (turn_id, position),
    UNIQUE (turn_id, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE turn_section_items_rebuilt (
    turn_id   INTEGER NOT NULL,
    section   INTEGER NOT NULL,
    position  INTEGER NOT NULL CHECK (position >= 0),
    item_hash TEXT    NOT NULL REFERENCES packet_items(hash),
    PRIMARY KEY (turn_id, section, position),
    FOREIGN KEY (turn_id, section) REFERENCES turn_sections_rebuilt(turn_id, position) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO turn_sections_rebuilt (turn_id, position, name, slot, header, weight)
SELECT turn_id, position, name, slot, header, weight FROM turn_sections;
INSERT INTO turn_section_items_rebuilt (turn_id, section, position, item_hash)
SELECT turn_id, section, position, item_hash FROM turn_section_items;

DROP VIEW turn_packets;
DROP TRIGGER turn_inference_evidence_insert;
-- {§db-process-triggers}: reinstalled from its owning INIT after migration.
DROP TRIGGER IF EXISTS workers_fork_copies_history;
DROP TABLE turn_section_items;
DROP TABLE turn_sections;
ALTER TABLE turn_sections_rebuilt RENAME TO turn_sections;
ALTER TABLE turn_section_items_rebuilt RENAME TO turn_section_items;
CREATE INDEX turn_section_items_item_hash ON turn_section_items (item_hash);

CREATE TRIGGER turn_inference_evidence_insert
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

CREATE VIEW turn_packets AS
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
