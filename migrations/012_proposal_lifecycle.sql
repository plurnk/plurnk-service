-- INIT: proposal_lifecycle
-- log_entries gets the state⊥status lifecycle dimension. Status is the HTTP-
-- aligned outcome (200, 202, 400, etc.); state is where in the lifecycle the
-- entry lives. Most rows are 'resolved' immediately (status 200/4xx written
-- in one shot); side-effecting actions that propose first transition through
-- 'proposed' → 'resolved' (accepted) or 'proposed' → 'failed' (rejected) or
-- 'proposed' → 'cancelled' (loop aborted, timeout). Per rummy SPEC.
--
-- outcome is a short reason string when state ∈ {failed, cancelled}.
-- Opaque to most callers; a few plugins parse it (timeout, rejected,
-- loop_aborted, policy_veto, etc).
--
-- attrs is the proposal payload — opaque JSON the scheme supplies when
-- emitting status 202, retrieved by the client to render review UI, and
-- handed back to the scheme's applyResolution() on accept. File scheme uses
-- it for {path, patch_full, patched_full}; exec scheme uses {command, args,
-- cwd}; etc. Engine doesn't interpret the contents.
ALTER TABLE log_entries ADD COLUMN state   TEXT NOT NULL DEFAULT 'resolved'
    CHECK (state IN ('proposed', 'resolved', 'failed', 'cancelled'));
ALTER TABLE log_entries ADD COLUMN outcome TEXT;
ALTER TABLE log_entries ADD COLUMN attrs   TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(attrs));
