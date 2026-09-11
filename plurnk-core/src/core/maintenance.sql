-- {§db-maintenance-optimize} The planner's statistics, refreshed where SQLite asks for them: once,
-- on the writer connection, as the last database step of daemon shutdown. SQLite bounds the work
-- itself (analysis_limit 400 under optimize) and only analyzes tables this connection planned
-- queries against and finds unanalyzed or grown.
-- PREP: maintenance_optimize
PRAGMA optimize;
