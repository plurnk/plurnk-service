-- INIT: loop_flags
-- Persists per-loop flags (mode, yolo, noWeb, noInteraction, noProposals)
-- declared in src/core/scheme-types.ts. Per-loop scope matches task #43's
-- design; runs may scope this longer in a future iteration.
--
-- Defaults to '{}' so existing loops read as all-false via the merge with
-- DEFAULT_LOOP_FLAGS in application code.
ALTER TABLE loops ADD COLUMN flags TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(flags));
