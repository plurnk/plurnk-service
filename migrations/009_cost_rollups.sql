CREATE TRIGGER turns_cost_rollup_insert_run
AFTER INSERT ON turns
BEGIN
    UPDATE runs
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (SELECT run_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER turns_cost_rollup_insert_session
AFTER INSERT ON turns
BEGIN
    UPDATE sessions
       SET cost_pico = cost_pico + NEW.usage_cost_pico
     WHERE id = (
         SELECT r.session_id
           FROM runs r
           JOIN loops l ON l.run_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;

CREATE TRIGGER turns_cost_rollup_update_run
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE runs
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (SELECT run_id FROM loops WHERE id = NEW.loop_id);
END;

CREATE TRIGGER turns_cost_rollup_update_session
AFTER UPDATE OF usage_cost_pico ON turns
WHEN NEW.usage_cost_pico != OLD.usage_cost_pico
BEGIN
    UPDATE sessions
       SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
     WHERE id = (
         SELECT r.session_id
           FROM runs r
           JOIN loops l ON l.run_id = r.id
          WHERE l.id = NEW.loop_id
     );
END;
