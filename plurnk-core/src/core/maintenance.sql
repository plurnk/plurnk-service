-- {§db-maintenance-optimize} The planner's statistics, refreshed where SQLite asks for them: once,
-- on the writer connection, as the last database step of daemon shutdown. SQLite bounds the work
-- itself (analysis_limit 400 under optimize) and only analyzes tables this connection planned
-- queries against and finds unanalyzed or grown.
-- PREP: maintenance_optimize
PRAGMA optimize;

-- PREP: maintenance_collect_packet_items
-- {§packet-items}: an item no turn's composition references is transient data, not information —
-- it is left behind when a worker or workspace is deleted and its turns cascade away.
DELETE FROM packet_items
WHERE NOT EXISTS (SELECT 1 FROM turn_section_items tsi WHERE tsi.item_hash = packet_items.hash);
