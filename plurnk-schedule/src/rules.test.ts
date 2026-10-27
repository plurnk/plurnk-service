import assert from "node:assert/strict";
import test from "node:test";
import { assertZone, describeRule, nextOccurrence, normalizeRule, parseRule, ScheduleRuleError, upcoming } from "./rules.ts";
import { isoString } from "./temporal.ts";
import { previewOccurrences, serviceDefinitions, validateConfiguration } from "./config.ts";
import { DefinitionError, readDefinition, targetSessionName } from "./definition.ts";

// ─── rules.test.ts ───
{
// 2026-09-16 12:30:15.250 UTC — 08:30:15.250 in New York.
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);

const codeOf = (run: () => unknown): string => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof ScheduleRuleError, `expected a ScheduleRuleError, got ${String(error)}`);
        return error.code;
    }
    assert.fail("expected a ScheduleRuleError");
};

test("{§schedule-rule} bare parts become a canonical DTSTART and RRULE, starting at the next whole second in the effective zone", () => {
    const parsed = normalizeRule("FREQ=HOURLY;COUNT=3", "America/New_York", NOW);
    assert.equal(parsed.text, "DTSTART;TZID=America/New_York:20260916T083016\nRRULE:FREQ=HOURLY;COUNT=3");
    assert.equal(parsed.zone, "America/New_York");
    assert.equal(parsed.bounded, true);
    assert.deepEqual(upcoming(parsed, NOW, 5).map(isoString), [
        "2026-09-16T08:30:16-04:00[America/New_York]",
        "2026-09-16T09:30:16-04:00[America/New_York]",
        "2026-09-16T10:30:16-04:00[America/New_York]",
    ]);
    assert.equal(parseRule(parsed.text).text, parsed.text, "the canonical text round-trips");
    assert.equal(normalizeRule("RRULE:FREQ=HOURLY;COUNT=3", "America/New_York", NOW).text, parsed.text, "the RRULE: prefix is the same rule");
    assert.equal(describeRule(parsed), "every hour for 3 times");
});

test("{§schedule-rule} a floating DTSTART is read in the effective zone; a zoned or UTC one keeps its own", () => {
    assert.equal(
        normalizeRule("DTSTART:20261101T090000\nRRULE:FREQ=DAILY;COUNT=2", "Europe/Paris", NOW).text,
        "DTSTART;TZID=Europe/Paris:20261101T090000\nRRULE:FREQ=DAILY;COUNT=2",
    );
    assert.equal(
        normalizeRule("DTSTART:20261101T090000Z\nRRULE:FREQ=DAILY;COUNT=2", "Europe/Paris", NOW).text,
        "DTSTART;TZID=UTC:20261101T090000\nRRULE:FREQ=DAILY;COUNT=2",
    );
    const tokyo = normalizeRule("DTSTART;TZID=Asia/Tokyo:20261101T090000\nRRULE:FREQ=DAILY;COUNT=2", "Europe/Paris", NOW);
    assert.equal(tokyo.text, "DTSTART;TZID=Asia/Tokyo:20261101T090000\nRRULE:FREQ=DAILY;COUNT=2");
    assert.equal(tokyo.zone, "Asia/Tokyo");
    assert.equal(codeOf(() => normalizeRule("FREQ=DAILY;COUNT=1", "Mars/Olympus", NOW)), "zone-unknown");
    assert.equal(codeOf(() => normalizeRule("DTSTART;TZID=Mars/Olympus:20261101T090000\nRRULE:FREQ=DAILY;COUNT=1", "UTC", NOW)), "zone-unknown");
    assert.throws(() => { assertZone("Nowhere/Land"); }, (error: unknown) => error instanceof ScheduleRuleError && error.code === "zone-unknown");
    assertZone("UTC");
});

test("{§schedule-rule} what the library would drop silently is refused by name", () => {
    assert.equal(codeOf(() => normalizeRule("FREQ=DAILY;BOGUS=1;COUNT=1", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("RRULE:FREQ=DAILY;COUNT=1\nRRULE:FREQ=WEEKLY", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("DTSTART:20261101T090000Z\nDTSTART:20261102T090000Z\nRRULE:FREQ=DAILY;COUNT=1", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("every day at nine", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("COUNT=3", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => parseRule("not a rule")), "rule-invalid");
    assert.match(
        (() => { try { normalizeRule("FREQ=DAILY;BOGUS=1", "UTC", NOW); } catch (error) { return (error as Error).message; } return ""; })(),
        /RRULE has no part named BOGUS/u,
    );
});

test("{§schedule-rule} COUNT or UNTIL bounds a rule; EXDATE lines ride along", () => {
    assert.equal(normalizeRule("FREQ=DAILY", "UTC", NOW).bounded, false);
    assert.equal(normalizeRule("FREQ=DAILY;COUNT=1", "UTC", NOW).bounded, true);
    const until = normalizeRule("FREQ=HOURLY;UNTIL=20260916T150000Z", "UTC", NOW);
    assert.equal(until.bounded, true);
    assert.deepEqual(upcoming(until, NOW, 10).map(isoString), [
        "2026-09-16T12:30:16+00:00[UTC]",
        "2026-09-16T13:30:16+00:00[UTC]",
        "2026-09-16T14:30:16+00:00[UTC]",
    ]);
    const excluded = normalizeRule("DTSTART:20261101T090000Z\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261102T090000Z", "UTC", NOW);
    assert.equal(excluded.text, "DTSTART;TZID=UTC:20261101T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261102T090000Z");
    assert.deepEqual(upcoming(excluded, NOW, 10).map(isoString), ["2026-11-01T09:00:00+00:00[UTC]", "2026-11-03T09:00:00+00:00[UTC]"]);
});

test("{§schedule-delivery} the next occurrence is strictly after the instant asked, and null once exhausted", () => {
    const parsed = normalizeRule("FREQ=HOURLY;COUNT=2", "UTC", NOW);
    const first = nextOccurrence(parsed, NOW);
    assert.equal(first === null ? null : isoString(first), "2026-09-16T12:30:16+00:00[UTC]");
    const second = nextOccurrence(parsed, first!.epochMilliseconds);
    assert.equal(second === null ? null : isoString(second), "2026-09-16T13:30:16+00:00[UTC]");
    assert.equal(nextOccurrence(parsed, second!.epochMilliseconds), null);
    assert.deepEqual(upcoming(parsed, second!.epochMilliseconds, 3), []);
});
}

// ─── config.test.ts ───
{
const HEARTBEAT = '{"rule":"FREQ=HOURLY","target":"session://bot","prompt":"Check in."}';

test("{§operator-config-precedence} schedule validation normalizes rules at the supplied instant without arming them", () => {
    const env = { TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1", PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "3", PLURNK_SCHEDULE_heartbeat: HEARTBEAT };
    const checked = validateConfiguration(env, Date.UTC(2026, 0, 1));
    assert.equal(checked.get("heartbeat")?.definition.rule, "DTSTART;TZID=UTC:20260101T000001\nRRULE:FREQ=HOURLY");
    assert.equal(checked.get("heartbeat")?.enabled, true);
    assert.deepEqual(checked.get("heartbeat")?.provenance, { kind: "environment", source: "PLURNK_SCHEDULE_heartbeat" });
    for (const [key, value] of Object.entries({
        TZ: "Not/A_Zone", PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "0", PLURNK_SCHEDULE_future_ENABLED: "bad",
        PLURNK_SCHEDULE_heartbeat: '{"rule":"FREQ=NEVER","target":"session://bot","prompt":"hello"}',
    })) {
        assert.throws(() => validateConfiguration({ ...env, [key]: value, PLURNK_SCHEDULE_heartbeat_ENABLED: "0" }, 0), (error: Error) => error.message.includes(key));
    }
});

test("{§schedule-residency} complete declarations sort by canonical alias and default enabled", () => {
    const definitions = serviceDefinitions({
        PLURNK_SCHEDULE_heart_beat: HEARTBEAT,
        PLURNK_SCHEDULE_nightly: '{"rule":"FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0","target":"session://janitor","prompt":"Tidy."}',
        PLURNK_SCHEDULE_ENABLED: "1",
        PLURNK_SCHEDULE_nightly_ENABLED: "0",
        UNRELATED: "1",
    });
    assert.deepEqual([...definitions.keys()], ["heart-beat", "nightly"]);
    assert.deepEqual(definitions.get("heart-beat"), { definition: { rule: "FREQ=HOURLY", target: "session://bot", prompt: "Check in." }, enabled: true, provenance: { kind: "environment", source: "PLURNK_SCHEDULE_heart_beat" } });
    assert.equal(definitions.get("nightly")?.enabled, false, "disabling retains the complete definition");
    assert.deepEqual([...serviceDefinitions({ PLURNK_SCHEDULE_ENABLED: "1" })], []);
    assert.throws(() => serviceDefinitions({}), /PLURNK_SCHEDULE_ENABLED is missing from the assembled environment floor\./u);
});

test("{§schedule-residency} per-alias enablement overrides the family default without hiding definitions", () => {
    const env = { PLURNK_SCHEDULE_heartbeat: HEARTBEAT, PLURNK_SCHEDULE_ENABLED: "0" };
    assert.equal(serviceDefinitions(env).get("heartbeat")?.enabled, false);
    assert.equal(serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat_ENABLED: "1" }).get("heartbeat")?.enabled, true);
    for (const value of ["", " \t"]) {
        assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_heartbeat: value }), /PLURNK_SCHEDULE_heartbeat must contain a definition/u);
    }
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_SCHEDULE_missing_ENABLED: "0" }), serviceDefinitions(env), "controls for future definitions do not manufacture schedules");
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_SCHEDULE_missing_ENABLED: "true" }), /PLURNK_SCHEDULE_missing_ENABLED must be 0 or 1/u);
});

test("{§schedule-residency} malformed service configuration fails at once, naming the variable", () => {
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

test("{§schedule-rule} preview count uses the assembled environment and shared integer validation", () => {
    assert.equal(previewOccurrences({ PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "3" }), 3);
    assert.throws(() => previewOccurrences({}), /PLURNK_SCHEDULE_PREVIEW_OCCURRENCES is missing from the assembled environment floor/u);
    for (const value of ["", "0", "2.5", "9007199254740992"]) {
        assert.throws(() => previewOccurrences({ PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: value }), /PLURNK_SCHEDULE_PREVIEW_OCCURRENCES must be a safe integer of at least 1/u);
    }
});
}

// ─── definition.test.ts ───
{
const definition = (target: string) => ({ rule: "FREQ=HOURLY;COUNT=1", target, prompt: "Check in." });

test("{§schedule-family} scheduled targets retain shared session identifiers exactly", () => {
    for (const name of ["a", "A", "0", "approach_a", "Approach_A", "trail-", "trail_", "01abcdef", "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63)]) {
        const target = `session://${name}`;
        assert.deepEqual(readDefinition(definition(target)), definition(target));
        assert.equal(targetSessionName(target), name);
    }
});

test("{§schedule-family} scheduled targets reject invalid identities and non-actor paths", () => {
    for (const target of [
        "session://", "session://_plurnk", "session://-a", `session://${"a".repeat(64)}`,
        "session://dot.name", "session://a b", "session://a\n", "session://a%62", "session://é",
        "session://alice/file.md", "session://alice?message=12345678", "session://alice#results",
        "session://user@alice", "session://alice:123", "https://alice",
    ]) {
        assert.throws(() => readDefinition(definition(target)), DefinitionError, target);
        assert.throws(() => targetSessionName(target), { name: "TypeError", message: `'${target}' is not a session:// target.` });
    }
});
}
