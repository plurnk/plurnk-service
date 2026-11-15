-- NoticeChannel: durable loop-scoped notices surviving daemon restarts across parked loops ({§operation-results}).

-- INIT: loops_clear_notices_on_terminate
DROP TRIGGER IF EXISTS loops_clear_notices_on_terminate;
CREATE TRIGGER loops_clear_notices_on_terminate
AFTER UPDATE OF status ON loops
WHEN NEW.status NOT IN (100, 102, 202)
BEGIN
    DELETE FROM loop_notices WHERE loop_id = NEW.id;
END;

-- PREP: notice_channel_delete_replacement
DELETE FROM loop_notices
WHERE loop_id = $loop_id AND replacement_key = $replacement_key;

-- PREP: notice_channel_insert
INSERT INTO loop_notices (loop_id, replacement_key, notice)
SELECT $loop_id, $replacement_key, $notice
WHERE EXISTS (SELECT 1 FROM loops WHERE id = $loop_id AND status IN (100, 102, 202));

-- PREP: notice_channel_peek
SELECT id, notice
FROM loop_notices
WHERE loop_id = $loop_id
ORDER BY id ASC;

-- PREP: notice_channel_acknowledge
DELETE FROM loop_notices
WHERE loop_id = $loop_id AND id <= $through_id;

-- PREP: notice_channel_clear
DELETE FROM loop_notices
WHERE loop_id = $loop_id;
