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
    assert.deepEqual([...serviceEnabled({})], []);
    assert.deepEqual([...serviceEnabled({ PLURNK_SCHEDULE_ENABLED: " " })], []);
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
