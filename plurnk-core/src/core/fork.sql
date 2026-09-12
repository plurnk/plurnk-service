-- Fork a worker: branch the log, share the world (SPEC {§machine-processes}). The branch's row
-- is claimed by worker_name_claim with fork_snapshot = 1, and that INSERT is the fork: the trigger
-- below copies the parent's history into the branch inside the same statement
-- ({§worker-fork-trigger}). Only worker, loop, turn and log ids are remapped, by natural key —
-- (worker, sequence) for a loop, (loop, sequence) for a turn, (turn, sequence) for a log row.
-- Nothing of the world is copied ({§machine-processes-fork-shares-the-world}).

-- INIT: workers_fork_copies_history
DROP TRIGGER IF EXISTS workers_fork_copies_history;
CREATE TRIGGER workers_fork_copies_history
AFTER INSERT ON workers
WHEN NEW.fork_event_boundary IS NOT NULL
BEGIN
    -- Loops: inherited history, never live work — a non-terminal status is clamped to 200 and
    -- given a plain success result ({§machine-processes-fork-copies-the-log}).
    INSERT INTO loops (
        worker_id, sequence, status, prompt, policy, model_route_id,
        spawn_model_route_id, reasoning_policy, max_turns, terminal_result
    )
    SELECT NEW.id, l.sequence,
           CASE WHEN l.status IN (200, 413, 429, 499, 500, 504, 508) THEN l.status ELSE 200 END,
           l.prompt, l.policy, l.model_route_id, l.spawn_model_route_id, l.reasoning_policy, l.max_turns,
           CASE WHEN l.status IN (200, 413, 429, 499, 500, 504, 508) THEN l.terminal_result ELSE '{"status":200}' END
    FROM loops l
    WHERE l.worker_id = NEW.parent_worker_id
    ORDER BY l.id;

    -- A forked loop is a new durable resource: a failure result identifies the branch loop.
    UPDATE loops
    SET terminal_result = json_set(terminal_result, '$.problem.instance', 'loop:///' || id)
    WHERE worker_id = NEW.id
      AND json_type(terminal_result, '$.problem') = 'object';

    -- Turns, loop remapped. Model calls, admission rows and provider requests stay with the
    -- source ({§machine-processes-fork-cost}).
    INSERT INTO turns (
        loop_id, sequence, timestamp, producer, kind, status, completed_at,
        usage_curation_budget, packet, finish_reason, model, meta
    )
    SELECT nl.id, t.sequence, t.timestamp, t.producer, t.kind, t.status,
           COALESCE(t.completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           t.usage_curation_budget, t.packet, t.finish_reason, t.model, t.meta
    FROM turns t
    JOIN loops ol ON ol.id = t.loop_id
    JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
    WHERE ol.worker_id = NEW.parent_worker_id
    ORDER BY t.id;

    -- {§packet-items}: a turn's composition is copied; the items are shared by hash.
    INSERT INTO turn_sections (turn_id, position, name, slot, header, weight)
    SELECT nt.id, ts.position, ts.name, ts.slot, ts.header, ts.weight
    FROM turn_sections ts
    JOIN turns ot ON ot.id = ts.turn_id
    JOIN loops ol ON ol.id = ot.loop_id
    JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
    JOIN turns nt ON nt.loop_id = nl.id AND nt.sequence = ot.sequence
    WHERE ol.worker_id = NEW.parent_worker_id;

    INSERT INTO turn_section_items (turn_id, section, position, item_hash)
    SELECT nt.id, tsi.section, tsi.position, tsi.item_hash
    FROM turn_section_items tsi
    JOIN turns ot ON ot.id = tsi.turn_id
    JOIN loops ol ON ol.id = ot.loop_id
    JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
    JOIN turns nt ON nt.loop_id = nl.id AND nt.sequence = ot.sequence
    WHERE ol.worker_id = NEW.parent_worker_id;

    INSERT INTO turn_sources (turn_id, kind, content, deep_hash)
    SELECT nt.id, s.kind, s.content, s.deep_hash
    FROM turn_sources s
    JOIN turns ot ON ot.id = s.turn_id
    JOIN loops ol ON ol.id = ot.loop_id
    JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
    JOIN turns nt ON nt.loop_id = nl.id AND nt.sequence = ot.sequence
    WHERE ol.worker_id = NEW.parent_worker_id;

    -- Log rows: durable events with their attribution, as inherited history. Each copied row
    -- passes through the log's own triggers exactly as the original did.
    INSERT INTO log_entries (
        worker_id, loop_id, turn_id, sequence, at, origin, source, ambient_event_id, inherited_history,
        op, signal, scheme, username, password, hostname, port, pathname, query, fragment,
        lineMarker, tx, mimetype_tx, rx, mimetype_rx, status_rx, weight, state, outcome, attrs, initial_folded
    )
    SELECT NEW.id, nl.id, nt.id, e.sequence, e.at, e.origin, e.source, e.ambient_event_id, 1,
           e.op, e.signal, e.scheme, e.username, e.password, e.hostname, e.port, e.pathname, e.query, e.fragment,
           e.lineMarker, e.tx, e.mimetype_tx, e.rx, e.mimetype_rx, e.status_rx, e.weight, e.state, e.outcome, e.attrs, e.initial_folded
    FROM log_entries e
    JOIN turns ot ON ot.id = e.turn_id
    JOIN loops ol ON ol.id = e.loop_id
    JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
    JOIN turns nt ON nt.loop_id = nl.id AND nt.sequence = ot.sequence
    WHERE e.worker_id = NEW.parent_worker_id
    ORDER BY e.id;

    -- Current projection: membership, folded intervals, and the admission turn, remapped.
    UPDATE log_entry_projections
    SET active = source.active,
        folded = source.folded,
        output_admission_turn_id = source.admission_turn_id,
        output_withheld = source.output_withheld
    FROM (
        SELECT ne.id AS log_entry_id, op.active, op.folded, op.output_withheld,
               (SELECT at2.id FROM turns at1
                JOIN loops al1 ON al1.id = at1.loop_id
                JOIN loops al2 ON al2.worker_id = NEW.id AND al2.sequence = al1.sequence
                JOIN turns at2 ON at2.loop_id = al2.id AND at2.sequence = at1.sequence
                WHERE at1.id = op.output_admission_turn_id) AS admission_turn_id
        FROM log_entries oe
        JOIN log_entry_projections op ON op.log_entry_id = oe.id
        JOIN turns ot ON ot.id = oe.turn_id
        JOIN loops ol ON ol.id = oe.loop_id
        JOIN loops nl ON nl.worker_id = NEW.id AND nl.sequence = ol.sequence
        JOIN turns nt ON nt.loop_id = nl.id AND nt.sequence = ot.sequence
        JOIN log_entries ne ON ne.turn_id = nt.id AND ne.sequence = oe.sequence
        WHERE oe.worker_id = NEW.parent_worker_id
    ) AS source
    WHERE log_entry_projections.log_entry_id = source.log_entry_id;

    -- Curation effects: both identities belong to the copied history, by construction of the join.
    INSERT INTO log_curation_effects (
        operation_log_entry_id, target_log_entry_id,
        active_before, active_after, folded_before, folded_after
    )
    SELECT nop.id, ntg.id, ef.active_before, ef.active_after, ef.folded_before, ef.folded_after
    FROM log_curation_effects ef
    JOIN log_entries oop ON oop.id = ef.operation_log_entry_id
    JOIN turns oopt ON oopt.id = oop.turn_id
    JOIN loops oopl ON oopl.id = oop.loop_id
    JOIN loops nopl ON nopl.worker_id = NEW.id AND nopl.sequence = oopl.sequence
    JOIN turns nopt ON nopt.loop_id = nopl.id AND nopt.sequence = oopt.sequence
    JOIN log_entries nop ON nop.turn_id = nopt.id AND nop.sequence = oop.sequence
    JOIN log_entries otg ON otg.id = ef.target_log_entry_id
    JOIN turns otgt ON otgt.id = otg.turn_id
    JOIN loops otgl ON otgl.id = otg.loop_id
    JOIN loops ntgl ON ntgl.worker_id = NEW.id AND ntgl.sequence = otgl.sequence
    JOIN turns ntgt ON ntgt.loop_id = ntgl.id AND ntgt.sequence = otgt.sequence
    JOIN log_entries ntg ON ntg.turn_id = ntgt.id AND ntg.sequence = otg.sequence
    WHERE oop.worker_id = NEW.parent_worker_id
    ORDER BY ef.operation_log_entry_id, ef.target_log_entry_id;

    -- Named scratch under the source's authority becomes the branch's; a live producer cannot be
    -- cloned ({§machine-processes-entry-inheritance}). Version defaults to 0.
    INSERT INTO entries (workspace_id, scheme, authority, pathname, attributes)
    SELECT NEW.workspace_id, e.scheme, NEW.name, e.pathname, e.attributes
    FROM entries e
    WHERE e.workspace_id = NEW.workspace_id
      AND e.authority = (SELECT name FROM workers WHERE id = NEW.parent_worker_id)
      AND e.scheme IN ('worker', 'prompt')
      AND NOT EXISTS (SELECT 1 FROM entry_channels c WHERE c.entry_id = e.id AND c.state = 'active')
    ORDER BY e.id;

    INSERT INTO entry_channels (entry_id, name, content, mimetype, weight, content_hash, deep_hash, state, producer_result)
    SELECT ne.id, c.name, c.content, c.mimetype, c.weight, c.content_hash, c.deep_hash, c.state, c.producer_result
    FROM entry_channels c
    JOIN entries oe ON oe.id = c.entry_id
    JOIN entries ne ON ne.workspace_id = oe.workspace_id AND ne.scheme = oe.scheme
                   AND ne.pathname = oe.pathname AND ne.authority = NEW.name
    WHERE oe.workspace_id = NEW.workspace_id
      AND oe.authority = (SELECT name FROM workers WHERE id = NEW.parent_worker_id)
      AND oe.scheme IN ('worker', 'prompt')
      AND NOT EXISTS (SELECT 1 FROM entry_channels a WHERE a.entry_id = oe.id AND a.state = 'active');
END;
