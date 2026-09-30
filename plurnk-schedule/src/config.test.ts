import assert from "node:assert/strict";
import { test } from "node:test";
import { previewOccurrences, serviceDefinitions } from "./config.ts";

const HEARTBEAT = '{"rule":"FREQ=HOURLY","target":"worker://bot","prompt":"Check in."}';

test("{§schedule-environment} complete declarations sort by canonical alias and default enabled", () => {
    const definitions = serviceDefinitions({
        PLURNK_SCHEDULE_heart_beat: HEARTBEAT,
        PLURNK_SCHEDULE_nightly: '{"rule":"FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0","target":"worker://janitor","prompt":"Tidy.","policy":{"proposals":"accept"}}',
        PLURNK_SCHEDULE_ENABLED: "1",
        PLURNK_SCHEDULE_nightly_ENABLED: "0",
        UNRELATED: "1",
    });
    assert.deepEqual([...definitions.keys()], ["heart-beat", "nightly"]);
    assert.deepEqual(definitions.get("heart-beat"), { definition: { rule: "FREQ=HOURLY", target: "worker://bot", prompt: "Check in." }, enabled: true });
    assert.deepEqual(definitions.get("nightly")?.definition.policy, { proposals: "accept" });
    assert.equal(definitions.get("nightly")?.enabled, false, "disabling retains the complete definition");
    assert.deepEqual([...serviceDefinitions({ PLURNK_SCHEDULE_ENABLED: "1" })], []);
    assert.throws(() => serviceDefinitions({}), /PLURNK_SCHEDULE_ENABLED is missing from the assembled environment floor\./u);
});

test("{§schedule-environment} per-alias enablement overrides the family default without hiding definitions", () => {
    const env = { PLURNK_SCHEDULE_heartbeat: HEARTBEAT, PLURNK_SCHEDULE_ENABLED: "0" };
    assert.equal(serviceDefinitions(env).get("heartbeat")?.enabled, false);
    assert.equal(serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat_ENABLED: "1" }).get("heartbeat")?.enabled, true);
    for (const value of ["", " \t"]) {
        assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: value }), /PLURNK_SCHEDULE_heartbeat must contain a definition/u);
    }
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_SCHEDULE_missing_ENABLED: "0" }), serviceDefinitions(env), "controls for future definitions do not manufacture schedules");
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_missing_ENABLED: "true" }), /PLURNK_SCHEDULE_missing_ENABLED must be 0 or 1/u);
});

test("{§schedule-environment} malformed service configuration fails at once, naming the variable", () => {
    const env = { PLURNK_SCHEDULE_ENABLED: "1" };
    for (const key of ["PLURNK_SCHEDULE_HEARTBEAT", "PLURNK_SCHEDULE_HeartBeat", "PLURNK_SCHEDULE_heart-beat"]) {
        assert.throws(() => serviceDefinitions({ ...env, [key]: HEARTBEAT }), new RegExp(`${key} .*lowercase`, "u"));
    }
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: "not json" }), /PLURNK_SCHEDULE_heartbeat is not JSON/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: '{"rule":"FREQ=HOURLY"}' }), /PLURNK_SCHEDULE_heartbeat must be a schedule definition/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: '{"rule":"FREQ=HOURLY","target":"agent://bot","prompt":"x"}' }), /must be a schedule definition/u);
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_ENABLED: '["heartbeat"]' }), /PLURNK_SCHEDULE_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: HEARTBEAT, PLURNK_SCHEDULE_heartbeat_ENABLED: "true" }), /PLURNK_SCHEDULE_heartbeat_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: '{"rule":"FREQ=HOURLY"}', PLURNK_SCHEDULE_heartbeat_ENABLED: "0" }), /PLURNK_SCHEDULE_heartbeat must be a schedule definition/u);
});

test("{§schedule-discovery-preview} preview count uses the assembled environment and shared integer validation", () => {
    assert.equal(previewOccurrences({ PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "3" }), 3);
    assert.throws(() => previewOccurrences({}), /PLURNK_SCHEDULE_PREVIEW_OCCURRENCES is missing from the assembled environment floor/u);
    for (const value of ["", "0", "2.5", "9007199254740992"]) {
        assert.throws(() => previewOccurrences({ PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: value }), /PLURNK_SCHEDULE_PREVIEW_OCCURRENCES must be a safe integer of at least 1/u);
    }
});
