import assert from "node:assert/strict";
import { test } from "node:test";
import { ENABLED, serviceDefinitions, serviceEnabled } from "./config.ts";

const HEARTBEAT = '{"rule":"FREQ=HOURLY","target":"worker://bot","prompt":"Check in."}';

test("{§schedule-environment} PLURNK_SCHEDULE_<ALIAS> definitions fold to the family grammar and sort", () => {
    const definitions = serviceDefinitions({
        PLURNK_SCHEDULE_HEARTBEAT: HEARTBEAT,
        PLURNK_SCHEDULE_nightly: '{"rule":"FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0","target":"worker://janitor","prompt":"Tidy.","policy":{"proposals":"accept"}}',
        PLURNK_SCHEDULE_ENABLED: '["heartbeat"]',
        UNRELATED: "1",
    });
    assert.deepEqual([...definitions.keys()], ["heartbeat", "nightly"]);
    assert.deepEqual(definitions.get("heartbeat"), { rule: "FREQ=HOURLY", target: "worker://bot", prompt: "Check in." });
    assert.deepEqual(definitions.get("nightly")?.policy, { proposals: "accept" });
    assert.deepEqual([...serviceEnabled({ PLURNK_SCHEDULE_ENABLED: '["heartbeat"]' })], ["heartbeat"]);
    assert.deepEqual([...serviceEnabled({ PLURNK_SCHEDULE_ENABLED: "[]" })], [], "[] is the one spelling of none");
    assert.throws(() => serviceEnabled({}), /PLURNK_SCHEDULE_ENABLED is missing from the assembled environment floor\./);
    assert.throws(() => serviceEnabled({ PLURNK_SCHEDULE_ENABLED: " " }), /PLURNK_SCHEDULE_ENABLED is not JSON\./);
});

test("{§schedule-environment} empty definitions mask inherited schedules and their default enabledness", () => {
    const env = {
        PLURNK_SCHEDULE_HEARTBEAT: "",
        PLURNK_SCHEDULE_OTHER: HEARTBEAT,
        PLURNK_SCHEDULE_ENABLED: '["heartbeat","other"]',
    };
    assert.deepEqual([...serviceDefinitions(env).keys()], ["other"]);
    assert.deepEqual([...serviceEnabled(env)], ["other"]);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: HEARTBEAT }), /both derive the schedule alias 'heartbeat'/u);
});

test("{§schedule-environment} malformed service configuration fails at once, naming the variable", () => {
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_HEARTBEAT: HEARTBEAT, PLURNK_SCHEDULE_heartbeat: HEARTBEAT }), /both derive the schedule alias 'heartbeat'/u);
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_BAD_ALIAS: HEARTBEAT }), /PLURNK_SCHEDULE_BAD_ALIAS derives the alias 'bad_alias'/u);
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_HEARTBEAT: "not json" }), /PLURNK_SCHEDULE_HEARTBEAT is not JSON/u);
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_HEARTBEAT: '{"rule":"FREQ=HOURLY"}' }), /PLURNK_SCHEDULE_HEARTBEAT must be a schedule definition/u);
    assert.throws(() => serviceDefinitions({ PLURNK_SCHEDULE_HEARTBEAT: '{"rule":"FREQ=HOURLY","target":"agent://bot","prompt":"x"}' }), /must be a schedule definition/u);
    assert.throws(() => serviceEnabled({ [ENABLED]: '{"heartbeat":true}' }), /must be a JSON array of aliases/u);
    assert.throws(() => serviceEnabled({ [ENABLED]: "[" }), /is not JSON/u);
});
