import assert from "node:assert/strict";
import test from "node:test";
import { assertZone, describeRule, nextOccurrence, normalizeRule, parseRule, ScheduleRuleError, upcoming } from "./rules.ts";
import { isoString } from "./temporal.ts";

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
    assert.deepEqual(upcoming(parsed, NOW, 5).map(isoString), [
        "2026-09-16T08:30:16-04:00[America/New_York]",
        "2026-09-16T09:30:16-04:00[America/New_York]",
        "2026-09-16T10:30:16-04:00[America/New_York]",
    ]);
    assert.equal(parseRule(parsed.text).text, parsed.text, "the canonical text round-trips");
    assert.equal(normalizeRule("RRULE:FREQ=HOURLY;COUNT=3", "America/New_York", NOW).text, parsed.text, "the RRULE: prefix is the same rule");
    assert.equal(describeRule(parsed), "every hour for 3 times");
});

test("{§schedule-rule} 5-field cron expressions normalize to canonical RRULE with BYSECOND=0", () => {
    const daily = normalizeRule("0 9 * * *", "America/New_York", NOW);
    assert.equal(daily.text, "DTSTART;TZID=America/New_York:20260916T083016\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    assert.deepEqual(upcoming(daily, NOW, 2).map(isoString), [
        "2026-09-16T09:00:00-04:00[America/New_York]",
        "2026-09-17T09:00:00-04:00[America/New_York]",
    ]);
    assert.equal(
        normalizeRule("* * * * *", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=MINUTELY;BYSECOND=0",
    );
    assert.equal(
        normalizeRule("*/15 * * * *", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;BYMINUTE=0,15,30,45;BYSECOND=0",
    );
    assert.equal(
        normalizeRule("0 9 * * 1-5", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYDAY=MO,TU,WE,TH,FR",
    );
    assert.equal(
        normalizeRule("0 9 1 * *", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYMONTHDAY=1",
    );
    assert.equal(
        normalizeRule("0 9 1 JAN *", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=YEARLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYMONTH=1;BYMONTHDAY=1",
    );
    assert.equal(
        normalizeRule("DTSTART:20261101T080000Z\n0 9 * * *", "UTC", NOW).text,
        "DTSTART;TZID=UTC:20261101T080000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    );
    assert.equal(codeOf(() => normalizeRule("60 9 * * *", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("0 24 * * *", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("0 9 32 * *", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("0 9 * 13 *", "UTC", NOW)), "rule-invalid");
    assert.equal(codeOf(() => normalizeRule("0 9 * * 8", "UTC", NOW)), "rule-invalid");
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

test("{§schedule-rule} UNTIL and EXDATE lines constrain upcoming occurrences", () => {
    const until = normalizeRule("FREQ=HOURLY;UNTIL=20260916T150000Z", "UTC", NOW);
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
