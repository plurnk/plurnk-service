-- The share's snapshot ({§share}). VACUUM INTO writes a transactionally consistent copy of the open
-- database to a new file, so a live daemon's database is never read in place. No INIT blocks: this
-- compiles against whatever database is shared and never alters it.

-- PREP: share_snapshot
VACUUM INTO :path;
