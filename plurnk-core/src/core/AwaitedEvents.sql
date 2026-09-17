-- {§awaited-event}: one durable attachment to one finite producer event.

-- PREP: awaited_event_join
INSERT INTO awaited_events (name, workspace_id, loop_id, scheme, event, source, due_at)
SELECT $name, $workspace_id, l.id, $scheme, $event, $source, $due_at
FROM loops l JOIN workers w ON w.id = l.worker_id
WHERE l.id = $loop_id AND w.id = $worker_id AND w.workspace_id = $workspace_id
  AND l.status IN (100, 102, 202)
ON CONFLICT (loop_id, scheme, event) WHERE result IS NULL
DO UPDATE SET name = awaited_events.name
RETURNING *;

-- PREP: awaited_event_get
SELECT * FROM awaited_events
WHERE workspace_id = $workspace_id AND scheme = $scheme AND name = $name;

-- PREP: awaited_event_pending
SELECT * FROM awaited_events WHERE scheme = $scheme AND result IS NULL ORDER BY id;

-- PREP: awaited_event_producers_missing
UPDATE awaited_events SET result = $result
WHERE result IS NULL AND scheme NOT IN (SELECT value FROM json_each($schemes));

-- PREP: awaited_event_settle
UPDATE awaited_events SET result = $result
WHERE workspace_id = $workspace_id AND scheme = $scheme AND event = $event AND result IS NULL
RETURNING loop_id, (SELECT worker_id FROM loops WHERE id = loop_id) AS worker_id;

-- PREP: awaited_event_cancel
UPDATE awaited_events SET result = $result
WHERE workspace_id = $workspace_id AND scheme = $scheme AND name = $name AND result IS NULL
RETURNING loop_id, (SELECT worker_id FROM loops WHERE id = loop_id) AS worker_id;

-- PREP: awaited_event_packet
SELECT * FROM awaited_events WHERE loop_id = $loop_id AND (result IS NULL OR observed = 0) ORDER BY id;

-- PREP: awaited_event_observe
UPDATE awaited_events SET observed = 1
WHERE result IS NOT NULL AND id IN (SELECT value FROM json_each($ids));

-- PREP: awaited_event_unobserved
SELECT id FROM awaited_events WHERE loop_id = $loop_id AND result IS NOT NULL AND observed = 0;

-- PREP: loop_live_obligations
SELECT streams, workers, events FROM loop_obligations WHERE loop_id = $loop_id;

-- INIT: awaited_events_retire_on_loop_end
DROP TRIGGER IF EXISTS awaited_events_retire_on_loop_end;
CREATE TRIGGER awaited_events_retire_on_loop_end
AFTER UPDATE OF status ON loops
WHEN OLD.status IN (100, 102, 202) AND NEW.status NOT IN (100, 102, 202)
BEGIN
    UPDATE awaited_events
    SET result = json_object('status', 499, 'problem', json_object(
        'type', 'https://problems.plurnk.xyz/lifecycle/wait/loop-ended',
        'title', 'Loop ended', 'status', 499,
        'detail', 'The owning loop ended before this awaited event settled.'
    )), observed = 1
    WHERE loop_id = NEW.id AND result IS NULL;
END;
