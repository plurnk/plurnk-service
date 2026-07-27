-- MIGRATE: 7 money_usd
-- v6 stored USD as integer pico-USD. The standard-money refactor changed the
-- durable contract to ordinary REAL USD; migrate the historical values before
-- removing the retired columns.
ALTER TABLE workspaces
ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0);

ALTER TABLE workers
ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0);

ALTER TABLE turns
ADD COLUMN usage_cost_usd REAL NOT NULL DEFAULT 0 CHECK (usage_cost_usd >= 0);

UPDATE workspaces SET cost_usd = cost_pico / 1000000000000.0;
UPDATE workers SET cost_usd = cost_pico / 1000000000000.0;
UPDATE turns SET usage_cost_usd = usage_cost_pico / 1000000000000.0;

DROP TRIGGER turns_cost_rollup_insert_worker;
DROP TRIGGER turns_cost_rollup_insert_workspace;
DROP TRIGGER turns_cost_rollup_update_worker;
DROP TRIGGER turns_cost_rollup_update_workspace;

ALTER TABLE workspaces DROP COLUMN cost_pico;
ALTER TABLE workers DROP COLUMN cost_pico;
ALTER TABLE turns DROP COLUMN usage_cost_pico;

CREATE TRIGGER turns_cost_rollup_insert_worker
AFTER INSERT ON turns
BEGIN
    UPDATE workers
       SET cost_usd = cost_usd + NEW.usage_cost_usd
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER turns_cost_rollup_insert_workspace
AFTER INSERT ON turns
BEGIN
    UPDATE workspaces
       SET cost_usd = cost_usd + NEW.usage_cost_usd
     WHERE id = (
         SELECT r.workspace_id
           FROM workers r
           JOIN loops l ON l.worker_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

CREATE TRIGGER turns_cost_rollup_update_worker
AFTER UPDATE OF usage_cost_usd ON turns
WHEN NEW.usage_cost_usd != OLD.usage_cost_usd
BEGIN
    UPDATE workers
       SET cost_usd = cost_usd + NEW.usage_cost_usd - OLD.usage_cost_usd
     WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER turns_cost_rollup_update_workspace
AFTER UPDATE OF usage_cost_usd ON turns
WHEN NEW.usage_cost_usd != OLD.usage_cost_usd
BEGIN
    UPDATE workspaces
       SET cost_usd = cost_usd + NEW.usage_cost_usd - OLD.usage_cost_usd
     WHERE id = (
         SELECT r.workspace_id
           FROM workers r
           JOIN loops l ON l.worker_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;
