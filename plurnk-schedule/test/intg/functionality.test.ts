import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick, setTimeout as sleep } from "node:timers/promises";
import { MAX_TIMER_MS, type FunctionalityFamilyHandle } from "@plurnk/plurnk-contracts";
import ScheduleFunctionality, { ScheduleFunctionalityError } from "../../src/Functionality.ts";
import type { ScheduleDefinition } from "../../src/definition.ts";
import type { DeliveryPort, SchedulerTimers } from "../../src/Scheduler.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Module from "../../src/Module.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

// ─── functionality.test.ts ───
{
// {§schedule-family} — the adapter's truth against fake time: the environment's rules, discovery
// that tells the time ({§schedule-rule}), admission that canonicalizes and bounds a rule,
// preparation outcomes, timers that deliver through the port ({§schedule-delivery}), failures that
// hold until enable, and residency across teardown ({§schedule-residency}).








// 2026-09-16 12:30:15.250 UTC.
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);
const SECOND = 1000;
const HOUR = 3_600_000;
const FIRST = Date.UTC(2026, 8, 16, 12, 30, 16);

interface Timer {
    readonly id: number;
    readonly callback: () => void;
    readonly delayMs: number;
    readonly at: number;
}

class FakeTime {
    now = NOW;
    readonly timers = new Map<number, Timer>();
    #next = 1;
    readonly clock = (): number => this.now;
    readonly api: SchedulerTimers = {
        set: (callback, delayMs) => {
            const id = this.#next++;
            this.timers.set(id, { id, callback, delayMs, at: this.now + delayMs });
            return id;
        },
        clear: (handle) => { this.timers.delete(handle as number); },
    };

    // Move to an instant and run every timer due by then, oldest first, letting deliveries settle.
    async advance(to: number): Promise<void> {
        this.now = to;
        for (const timer of [...this.timers.values()].toSorted((left, right) => left.at - right.at)) {
            if (timer.at > to) continue;
            this.timers.delete(timer.id);
            timer.callback();
            await flush();
        }
    }

    delays(): number[] {
        return [...this.timers.values()].map(({ delayMs }) => delayMs);
    }
}

const flush = async (): Promise<void> => {
    for (let round = 0; round < 8; round += 1) await nextTick();
};

class FakePort implements DeliveryPort {
    sessions: { id: number; name: string }[] = [{ id: 7, name: "bot" }];
    readonly deliveries: object[] = [];
    refusal: Error | null = null;

    async listSessions(): Promise<readonly { id: number; name: string }[]> {
        return this.sessions;
    }

    async runLoop(args: object): Promise<unknown> {
        if (this.refusal !== null) throw this.refusal;
        this.deliveries.push(args);
        return { status: 200, action: "enqueued_new_loop", loopId: this.deliveries.length };
    }
}

type Preparation = Parameters<ScheduleFunctionality["prepare"]>[0];
const preparation = (
    workspaceId: number,
    enabled: Readonly<Record<string, ScheduleDefinition>>,
    options: { previous?: Preparation["previous"]; failure?: "publish-unavailable" | "reject"; force?: string; admissions?: Preparation["admissions"] } = {},
): Preparation => ({
    workspaceId,
    signal: new AbortController().signal,
    enabled: new Map(Object.entries(enabled).map(([alias, definition]) => [alias, { definition }])),
    previous: options.previous ?? null,
    failure: options.failure ?? "publish-unavailable",
    progress: () => undefined,
    ...(options.force === undefined ? {} : { force: options.force }),
    admissions: options.admissions ?? [],
    retain: () => () => {},
});

const problemOf = async (run: () => Promise<unknown>): Promise<{ type: string; status: number; detail: string; errors?: unknown }> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ScheduleFunctionalityError, `expected a ScheduleFunctionalityError, got ${String(error)}`);
        return error.problem;
    }
    assert.fail("expected a Problem");
};

const HEARTBEAT = { rule: "FREQ=HOURLY", target: "session://bot", prompt: "Check in." };
const BEAT = { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://bot", prompt: "Beat." };

const family = (time: FakeTime, env: Record<string, string> = {}, reports: string[] = []): ScheduleFunctionality =>
    new ScheduleFunctionality({ TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1", PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "3", ...env }, { clock: time.clock, timers: time.api, report: (message) => { reports.push(message); } });

const attached = (adapter: ScheduleFunctionality, zone = "UTC"): number[] => {
    const refreshed: number[] = [];
    const handle: FunctionalityFamilyHandle = {
        invoke: async () => { throw new Error("not invoked in this test"); },
        refresh: async ({ workspaceId }) => { refreshed.push(workspaceId); },
    };
    adapter.attach(handle, {
        readWorkspaceEnvironment: async () => (ambient) => ({ ...ambient, TZ: zone }),
        // The invoking Session's own override sits above the workspace layer.
        readSessionEnvironment: async () => (ambient) => ({ ...ambient, TZ: "Asia/Tokyo" }),
    });
    return refreshed;
};

for (const settlement of ["commit", "abort"] as const) {
    test(`{§functionality-replacement} ${settlement} of an identical schedule never replays its next occurrence`, async (t) => {
        const time = new FakeTime();
        const adapter = family(time);
        const port = new FakePort();
        adapter.scheduler.start(port);
        t.after(() => adapter.scheduler.close());
        const original = await adapter.prepare(preparation(1, { beat: BEAT }));
        original.publish(); await original.commit();
        time.now += 100;
        const admission = await adapter.admit({ alias: "beat", definition: BEAT }, { workspaceId: 1 });
        const candidate = await adapter.prepare(preparation(1, { beat: admission.definition }, { previous: original.snapshot, admissions: [admission] }));
        await candidate[settlement]();
        await time.advance(FIRST);
        assert.equal(port.deliveries.length, 1);
        assert.deepEqual(time.delays(), [HOUR], "the next occurrence is an hour later, not an immediate repeat");
        await time.advance(FIRST + HOUR);
        assert.equal(port.deliveries.length, 2);
        assert.deepEqual(adapter.scheduler.armed(1), []);
    });
}

test("{§functionality-replacement} a new schedule target cannot inherit the old target's delivery failure", async (t) => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    port.sessions = [];
    adapter.scheduler.start(port);
    t.after(() => adapter.scheduler.close());
    await (await adapter.prepare(preparation(1, { beat: BEAT }))).commit();
    await time.advance(FIRST);
    const held = await adapter.prepare(preparation(1, { beat: BEAT }));
    assert.equal(held.outcomes.get("beat")?.state, "unavailable");
    held.publish(); await held.commit();
    port.sessions = [{ id: 8, name: "repaired" }];
    const changed = { ...BEAT, target: "session://repaired" };
    const candidate = await adapter.prepare(preparation(1, { beat: changed }, { previous: held.snapshot }));
    assert.equal(candidate.outcomes.get("beat")?.state, "active");
    await candidate.abort();
    assert.equal((await adapter.prepare(preparation(1, { beat: BEAT }))).outcomes.get("beat")?.state, "unavailable",
        "an aborted replacement leaves the preceding failure intact");
    await (await adapter.prepare(preparation(1, { beat: changed }))).commit();
    await time.advance(FIRST + HOUR);
    assert.deepEqual(port.deliveries, [{ workspaceId: 1, sessionId: 8, prompt: "Beat.", source: "schedule://beat" }]);
});

test("{§functionality-coordinator} aborting an enable retry preserves the schedule's delivery failure", async (t) => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    port.sessions = [];
    adapter.scheduler.start(port);
    t.after(() => adapter.scheduler.close());
    await (await adapter.prepare(preparation(1, { beat: BEAT }))).commit();
    await time.advance(FIRST);
    const held = await adapter.prepare(preparation(1, { beat: BEAT }));
    assert.equal(held.outcomes.get("beat")?.state, "unavailable");
    held.publish(); await held.commit();
    port.sessions = [{ id: 7, name: "bot" }];
    const retry = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: held.snapshot, force: "beat" }));
    assert.equal(retry.outcomes.get("beat")?.state, "active");
    await retry.abort();
    const unchanged = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: held.snapshot }));
    assert.deepEqual(unchanged.outcomes.get("beat"), held.outcomes.get("beat"));
    unchanged.publish(); await unchanged.commit();
    assert.deepEqual(adapter.scheduler.armed(1), []);
    await (await adapter.prepare(preparation(1, { beat: BEAT }, { force: "beat" }))).commit();
    await time.advance(FIRST + HOUR);
    assert.deepEqual(port.deliveries, [{ workspaceId: 1, sessionId: 7, prompt: "Beat.", source: "schedule://beat" }]);
});

test("{§schedule-delivery} identical replacement cannot replay an occurrence delivered during preparation", async (t) => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    adapter.scheduler.start(port);
    t.after(() => adapter.scheduler.close());
    const once = { ...BEAT, rule: BEAT.rule.replace("COUNT=2", "COUNT=1") };
    const original = await adapter.prepare(preparation(1, { once }));
    original.publish(); await original.commit();
    const admission = await adapter.admit({ alias: "once", definition: once }, { workspaceId: 1 });
    const candidate = await adapter.prepare(preparation(1, { once: admission.definition }, { previous: original.snapshot, admissions: [admission] }));
    await time.advance(FIRST);
    assert.equal(port.deliveries.length, 1);
    candidate.publish(); await candidate.commit();
    await time.advance(FIRST + HOUR);
    assert.equal(port.deliveries.length, 1);
    assert.deepEqual(adapter.scheduler.armed(1), []);
});

test("{§functionality-replacement} schedule replacement publishes the new target and timing only on commit", async (t) => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    port.sessions.push({ id: 8, name: "other" });
    adapter.scheduler.start(port);
    t.after(() => adapter.scheduler.close());
    const original = await adapter.prepare(preparation(1, { beat: BEAT }));
    original.publish(); await original.commit();
    const replacement = { rule: "DTSTART;TZID=UTC:20260916T123017\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://other", prompt: "Changed." };
    const prepare = async () => {
        const admission = await adapter.admit({ alias: "beat", definition: replacement }, { workspaceId: 1 });
        return adapter.prepare(preparation(1, { beat: admission.definition }, { previous: original.snapshot, admissions: [admission] }));
    };
    const aborted = await prepare();
    await aborted.abort();
    await time.advance(FIRST);
    assert.deepEqual(port.deliveries, [{ workspaceId: 1, sessionId: 7, prompt: "Beat.", source: "schedule://beat" }]);
    const accepted = await prepare();
    time.now = FIRST + 2 * SECOND;
    accepted.publish(); await accepted.commit();
    assert.deepEqual(time.delays(), [0], "a newly admitted occurrence crossed during publication fires immediately");
    await time.advance(time.now);
    assert.deepEqual(port.deliveries[1], { workspaceId: 1, sessionId: 8, prompt: "Changed.", source: "schedule://beat" });
    await time.advance(FIRST + HOUR);
    assert.equal(port.deliveries.length, 2, "the old rule's next occurrence was withdrawn");
    await time.advance(FIRST + HOUR + SECOND);
    assert.equal(port.deliveries.length, 3);
    assert.deepEqual(port.deliveries[2], port.deliveries[1]);
});

test("{§schedule-residency} environment definitions are the service baseline with PLURNK_SCHEDULE_ENABLED as the newborn default", async () => {
    const adapter = family(new FakeTime(), {
        PLURNK_SCHEDULE_heartbeat: JSON.stringify(HEARTBEAT),
        PLURNK_SCHEDULE_nightly: JSON.stringify({ rule: "FREQ=DAILY", target: "session://janitor", prompt: "Tidy." }),
        PLURNK_SCHEDULE_nightly_ENABLED: "0",
    });
    assert.deepEqual(await adapter.available(), [
        { alias: "heartbeat", definition: { ...HEARTBEAT, rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY" }, enabled: true, provenance: { kind: "environment", source: "PLURNK_SCHEDULE_heartbeat" } },
        { alias: "nightly", definition: { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=DAILY", target: "session://janitor", prompt: "Tidy." }, enabled: false, provenance: { kind: "environment", source: "PLURNK_SCHEDULE_nightly" } },
    ]);
    await assert.rejects(family(new FakeTime(), { PLURNK_SCHEDULE_broken: JSON.stringify({ ...HEARTBEAT, rule: "FREQ=DAILY;BOGUS=1" }), PLURNK_SCHEDULE_broken_ENABLED: "0" }).available(), /PLURNK_SCHEDULE_broken: The rule is not a readable RFC 5545 recurrence: RRULE has no part named BOGUS/u);
    await assert.rejects(new ScheduleFunctionality({}).available(), /TZ is unset/u);
});

test("{§schedule-rule} the panel says how many occurrences a reading previews, and it is never a rule", async () => {
    const one = family(new FakeTime(), { PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "1" });
    const [daily] = await one.discover({ source: "FREQ=DAILY" }, { workspaceId: 1 });
    assert.match(String(daily.summary), /; next 2026-09-16T12:30:16\+00:00\[UTC\]; unbounded/u, "one occurrence, not three");
    assert.deepEqual(await one.available(), [], "the control key declares no rule");
    const time = new FakeTime();
    await assert.rejects(
        new ScheduleFunctionality({ TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, { clock: time.clock, timers: time.api }).available(),
        /PLURNK_SCHEDULE_PREVIEW_OCCURRENCES is missing from the assembled environment floor/u,
        "resolution rejects a missing floor without preventing the manager's construction",
    );
});

test("{§schedule-rule} discovery tells the time beside the rule it reads, in the effective zone, and persists nothing", async () => {
    const adapter = family(new FakeTime());
    assert.deepEqual(await adapter.discover({ source: "FREQ=HOURLY;COUNT=2" }, { workspaceId: 1 }), [{
        alias: "hourly",
        summary: "now 2026-09-16T12:30:15+00:00[UTC]; every hour for 2 times; next 2026-09-16T12:30:16+00:00[UTC], 2026-09-16T13:30:16+00:00[UTC]",
        definition: { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2" },
        provenance: { kind: "rule", source: "FREQ=HOURLY;COUNT=2" },
    }]);
    const [tokyo] = await family(new FakeTime(), { TZ: "Asia/Tokyo" }).discover({ source: "FREQ=DAILY" }, { workspaceId: 1 });
    assert.equal(
        tokyo.summary,
        "now 2026-09-16T21:30:15+09:00[Asia/Tokyo]; every day at 9:30:16 PM; next 2026-09-16T21:30:16+09:00[Asia/Tokyo], 2026-09-17T21:30:16+09:00[Asia/Tokyo], 2026-09-18T21:30:16+09:00[Asia/Tokyo]; unbounded: add needs COUNT or UNTIL",
    );
    assert.equal((await problemOf(() => family(new FakeTime(), { TZ: "Mars/Olympus" }).discover({ source: "FREQ=DAILY" }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/zone-unknown");
    assert.equal((await problemOf(() => adapter.discover({ source: "FREQ=DAILY;BOGUS=1" }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/rule-invalid");
});

test("{§schedule-rule} admission canonicalizes the rule in the workspace's zone and refuses an unbounded one", async () => {
    const adapter = family(new FakeTime());
    attached(adapter, "Europe/Paris");
    assert.deepEqual(await adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=2", target: "session://bot", prompt: "Beat." } }, { workspaceId: 1 }), {
        alias: "beat",
        definition: { rule: "DTSTART;TZID=Europe/Paris:20260916T143016\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://bot", prompt: "Beat." },
        preparation: NOW,
    });
    const bySession = await adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=2", target: "session://bot", prompt: "Beat." } }, { workspaceId: 1, sessionId: 7 });
    assert.equal((bySession.definition as { rule: string }).rule, "DTSTART;TZID=Asia/Tokyo:20260916T213016\nRRULE:FREQ=HOURLY;COUNT=2", "the invoking Session's own TZ override wins over the workspace layer");
    const [preview] = await adapter.discover({ source: "FREQ=DAILY;COUNT=1" }, { workspaceId: 1, sessionId: 7 });
    assert.match(preview.summary ?? "", /^now 2026-09-16T21:30:15\+09:00\[Asia\/Tokyo\]/u, "the Session reads the time in its own zone");
    assert.equal((await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY", target: "session://bot", prompt: "Beat." } }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/rule-unbounded");
    assert.equal((await problemOf(() => adapter.admit({ definition: HEARTBEAT }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/alias-required");
    const invalid = await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=1", target: "agent://bot", prompt: "Beat." } }, { workspaceId: 1 }));
    assert.equal(invalid.type, "https://problems.plurnk.xyz/schedule/functionality/definition-invalid");
    assert.ok(Array.isArray(invalid.errors) && invalid.errors.length > 0, "the schema errors ride along");
    assert.equal((await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=1", target: "session://bot", prompt: "Beat.", extra: true } }, { workspaceId: 1 }))).status, 400);
});

test("{§schedule-residency} preparation publishes one outcome per rule, commit arms, teardown leaves the timers armed", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const exhausted = { rule: "DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY;COUNT=1", target: "session://bot", prompt: "Once." };
    const heartbeat = { ...HEARTBEAT, rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY" };
    const prepared = await adapter.prepare(preparation(1, { heartbeat, beat: BEAT, once: exhausted }));
    assert.deepEqual(prepared.documents, []);
    assert.deepEqual(prepared.outcomes.get("beat"), {
        state: "active",
        detail: {
            path: "schedule:///rules/beat",
            rule: BEAT.rule,
            zone: "UTC",
            text: "every hour for 2 times",
            next: "2026-09-16T12:30:16+00:00[UTC]",
            exhausted: false,
            target: "session://bot",
        },
    });
    assert.deepEqual(prepared.outcomes.get("heartbeat"), {
        state: "active",
        detail: { path: "schedule:///rules/heartbeat", rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY", zone: "UTC", text: "every hour", next: "2026-09-16T12:30:16+00:00[UTC]", exhausted: false, target: "session://bot" },
    });
    assert.deepEqual(prepared.outcomes.get("once"), {
        state: "active",
        detail: { path: "schedule:///rules/once", rule: exhausted.rule, zone: "UTC", text: "every day at 9 AM for 1 time; no future occurrences", next: null, exhausted: true, target: "session://bot" },
    });
    assert.deepEqual(adapter.scheduler.armed(1), [], "nothing arms before commit");
    prepared.publish(); await prepared.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat", "heartbeat"], "an exhausted rule arms nothing");
    assert.deepEqual(time.delays(), [FIRST - NOW, FIRST - NOW]);
    await adapter.teardown(prepared.snapshot, { workspaceId: 1 });
    assert.deepEqual(adapter.scheduler.armed(1), ["beat", "heartbeat"], "cooling keeps the obligation");
    const narrowed = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: prepared.snapshot }));
    narrowed.publish(); await narrowed.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat"], "disable and remove disarm through the published set");
    const emptied = await adapter.prepare(preparation(1, {}, { previous: narrowed.snapshot }));
    emptied.publish(); await emptied.commit();
    assert.deepEqual(adapter.scheduler.armed(1), []);
    assert.deepEqual(time.delays(), []);
});

test("{§schedule-family} an unreadable enabled definition is unavailable with its Problem, and rejects only an add that introduces it", async () => {
    const reports: string[] = [];
    const adapter = family(new FakeTime(), {}, reports);
    const broken = { rule: "FREQ=DAILY;BOGUS=1", target: "session://bot", prompt: "x" };
    const published = await adapter.prepare(preparation(1, { broken, beat: BEAT }));
    const outcome = published.outcomes.get("broken");
    assert.equal(outcome?.state, "unavailable");
    assert.equal((outcome as { problem: { type: string } }).problem.type, "https://problems.plurnk.xyz/schedule/functionality/rule-invalid");
    assert.equal(published.outcomes.get("beat")?.state, "active");
    assert.deepEqual(reports, ["schedule 'broken' unavailable in workspace 1"]);
    await assert.rejects(adapter.prepare(preparation(1, { broken }, { failure: "reject" })), (error: unknown) =>
        error instanceof ScheduleFunctionalityError && error.problem.status === 400);
    const carried = await adapter.prepare(preparation(1, { broken }, { failure: "reject", previous: published.snapshot }));
    assert.equal(carried.outcomes.get("broken")?.state, "unavailable", "a carried failure never rejects a later mutation");
    assert.equal(reports.length, 1, "a carried failure is not reported again");
});

test("{§schedule-delivery} an occurrence delivers the message to the target session as an arrival from schedule://<alias>, then the next one arms", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const refreshed = attached(adapter);
    const port = new FakePort();
    adapter.scheduler.start(port);
    await (await adapter.prepare(preparation(3, { beat: BEAT }))).commit();
    await time.advance(FIRST);
    assert.deepEqual(port.deliveries, [{ workspaceId: 3, sessionId: 7, prompt: "Beat.", source: "schedule://beat" }]);
    assert.deepEqual(refreshed, [3], "a settled delivery republishes the outcomes");
    assert.deepEqual(time.delays(), [HOUR], "the next occurrence armed from the fire");
    const republished = await adapter.prepare(preparation(3, { beat: BEAT }));
    assert.equal((republished.outcomes.get("beat") as { detail: { next: string } }).detail.next, "2026-09-16T13:30:16+00:00[UTC]");
    republished.publish(); await republished.commit();
    await time.advance(FIRST + HOUR);
    assert.equal(port.deliveries.length, 2);
    assert.deepEqual(adapter.scheduler.armed(3), [], "the rule is exhausted");
    const done = await adapter.prepare(preparation(3, { beat: BEAT }));
    assert.deepEqual((done.outcomes.get("beat") as { detail: { next: null; exhausted: boolean } }).detail, {
        path: "schedule:///rules/beat", rule: BEAT.rule, zone: "UTC", text: "every hour for 2 times; no future occurrences", next: null, exhausted: true, target: "session://bot",
    });
    await adapter.scheduler.close();
});

test("{§schedule-rule} {§schedule-delivery} an occurrence past before add is exhausted; a bare rule starts from add", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    adapter.scheduler.start(port);
    try {
        const identity = { workspaceId: 5 };
        const [candidate] = await adapter.discover({ source: "FREQ=SECONDLY;COUNT=1" }, identity);
        assert.ok(candidate);
        time.now = NOW + 5 * SECOND;
        const { definition: expired } = await adapter.admit({ alias: "expired", definition: {
            ...candidate.definition, target: "session://bot", prompt: "Expired.",
        } }, identity);
        const { definition: fresh } = await adapter.admit({ alias: "fresh", definition: {
            rule: "FREQ=SECONDLY;COUNT=1", target: "session://bot", prompt: "Fresh.",
        } }, identity);
        const prepared = await adapter.prepare(preparation(5, { expired, fresh }));
        const expiredOutcome = prepared.outcomes.get("expired");
        assert.ok(expiredOutcome?.state === "active");
        const expiredDetail = expiredOutcome.detail as { next: string | null; exhausted: boolean; text: string };
        assert.deepEqual([expiredDetail.next, expiredDetail.exhausted], [null, true], "an expired candidate has no occurrence left to deliver");
        assert.match(expiredDetail.text, /; no future occurrences$/u, "the rule description states what exhaustion means, without implying delivery");
        const freshOutcome = prepared.outcomes.get("fresh");
        assert.ok(freshOutcome?.state === "active");
        const freshDetail = freshOutcome.detail as { next: string | null; exhausted: boolean };
        assert.deepEqual([freshDetail.next, freshDetail.exhausted], ["2026-09-16T12:30:21+00:00[UTC]", false]);
        prepared.publish(); await prepared.commit();
        assert.deepEqual(adapter.scheduler.armed(5), ["fresh"], "no implicit replay or re-dating of the expired occurrence");
        await time.advance(FIRST + 5 * SECOND);
        assert.deepEqual(port.deliveries, [{ workspaceId: 5, sessionId: 7, prompt: "Fresh.", source: "schedule://fresh" }]);
    } finally { await adapter.scheduler.close(); }
});

test("{§schedule-delivery} a single occurrence that passes between add and its arming still arms, fires at once, and delivers once", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const port = new FakePort();
    adapter.scheduler.start(port);
    // The model asks for a reminder four seconds ahead; preparation and arming run five seconds later.
    const soon = { rule: "DTSTART;TZID=UTC:20260916T123019\nRRULE:FREQ=MINUTELY;COUNT=1", target: "session://bot", prompt: "Soon." };
    const admission = await adapter.admit({ alias: "soon", definition: soon }, { workspaceId: 5 });
    const { definition } = admission;
    time.now = NOW + 5 * SECOND;
    const prepared = await adapter.prepare(preparation(5, { soon: definition }, { admissions: [admission] }));
    const detail = (outcome: unknown): { next: string | null; exhausted: boolean } => (outcome as { detail: { next: string | null; exhausted: boolean } }).detail;
    assert.deepEqual([detail(prepared.outcomes.get("soon")).next, detail(prepared.outcomes.get("soon")).exhausted],
        ["2026-09-16T12:30:19+00:00[UTC]", false], "the receipt names the occurrence the add was judged against, not exhaustion");
    prepared.publish(); await prepared.commit();
    assert.deepEqual(adapter.scheduler.armed(5), ["soon"], "the occurrence armed although it has passed");
    assert.deepEqual(time.delays(), [0], "and fires at once");
    await time.advance(time.now);
    assert.equal(port.deliveries.length, 1, "delivered once");
    assert.equal((port.deliveries[0] as { source: string }).source, "schedule://soon");
    assert.deepEqual(adapter.scheduler.armed(5), [], "nothing more to arm");
    const after = await adapter.prepare(preparation(5, { soon: definition }, { previous: prepared.snapshot }));
    assert.deepEqual([detail(after.outcomes.get("soon")).next, detail(after.outcomes.get("soon")).exhausted], [null, true], "the present is the cursor once the admission is consumed");
    await adapter.scheduler.close();

    // A daemon that starts later has no admission memory: the stored rule arms from the present.
    const later = new FakeTime();
    later.now = NOW + 5 * SECOND;
    const restarted = family(later);
    restarted.scheduler.start(new FakePort());
    const stored = await restarted.prepare(preparation(5, { soon: definition }));
    assert.deepEqual([detail(stored.outcomes.get("soon")).next, detail(stored.outcomes.get("soon")).exhausted], [null, true]);
    stored.publish(); await stored.commit();
    assert.deepEqual(restarted.scheduler.armed(5), [], "a start arms from the present, never a backlog");
    await restarted.scheduler.close();
});

test("{§schedule-delivery} a late fire delivers once and skips what it missed; a far occurrence arms in hops", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    attached(adapter);
    const port = new FakePort();
    adapter.scheduler.start(port);
    const hourly = { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=10", target: "session://bot", prompt: "Tick." };
    await (await adapter.prepare(preparation(1, { hourly }))).commit();
    await time.advance(FIRST + 3 * HOUR + SECOND);
    assert.equal(port.deliveries.length, 1, "no backlog");
    assert.deepEqual(time.delays(), [HOUR - SECOND], "armed for the first occurrence after now");
    const far = { rule: "DTSTART;TZID=UTC:20270101T000000\nRRULE:FREQ=YEARLY;COUNT=1", target: "session://bot", prompt: "Happy new year." };
    await (await adapter.prepare(preparation(2, { far }))).commit();
    assert.deepEqual(time.delays().filter((delay) => delay === MAX_TIMER_MS), [MAX_TIMER_MS], "setTimeout's ceiling is one hop");
    await time.advance(time.now + MAX_TIMER_MS);
    assert.equal(port.deliveries.length, 2, "the hourly rule fired again in the hop; the far one did not");
    assert.deepEqual(adapter.scheduler.armed(2), ["far"], "the far rule re-armed without delivering");
    await adapter.scheduler.close();
});

test("{§schedule-delivery} a failed delivery holds the rule unavailable with its Problem until enable, a changed rule, or removal", async () => {
    const time = new FakeTime();
    const reports: string[] = [];
    const adapter = family(time, {}, reports);
    const refreshed = attached(adapter);
    const port = new FakePort();
    port.sessions = [];
    adapter.scheduler.start(port);
    await (await adapter.prepare(preparation(1, { beat: BEAT }))).commit();
    await time.advance(FIRST);
    assert.deepEqual(port.deliveries, []);
    assert.deepEqual(reports, ["scheduled message 'beat' was not delivered in workspace 1"]);
    assert.deepEqual(refreshed, [1]);
    assert.deepEqual(adapter.scheduler.armed(1), [], "a failed rule disarms");
    const held = await adapter.prepare(preparation(1, { beat: BEAT }));
    const outcome = held.outcomes.get("beat") as { state: string; problem: { type: string; status: number; detail: string } };
    assert.equal(outcome.state, "unavailable");
    assert.equal(outcome.problem.type, "https://problems.plurnk.xyz/schedule/delivery/target-missing");
    assert.equal(outcome.problem.status, 404);
    assert.equal(outcome.problem.detail, "No session named 'bot' exists in this workspace."); // {§schedule-residency}
    held.publish(); await held.commit();
    assert.deepEqual(adapter.scheduler.armed(1), [], "republishing does not retry on its own");

    port.sessions = [{ id: 7, name: "bot" }];
    const forced = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: held.snapshot, force: "beat" }));
    assert.equal(forced.outcomes.get("beat")?.state, "active", "enable retries");
    forced.publish(); await forced.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat"]);

    port.refusal = new Error("the loop lane is closed");
    await time.advance(time.now + 2 * HOUR);
    const refused = (await adapter.prepare(preparation(1, { beat: BEAT }))).outcomes.get("beat") as unknown as { problem: { type: string; diagnostic: string } };
    assert.equal(refused.problem.type, "https://problems.plurnk.xyz/schedule/delivery/delivery-failed");
    assert.equal(refused.problem.diagnostic, "the loop lane is closed");

    port.refusal = null;
    const changed = { ...BEAT, rule: "DTSTART;TZID=UTC:20260916T160000\nRRULE:FREQ=HOURLY;COUNT=1" };
    const replaced = await adapter.prepare(preparation(1, { beat: changed }));
    assert.equal(replaced.outcomes.get("beat")?.state, "active", "a changed rule is fresh");
    replaced.publish(); await replaced.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat"]);
    await adapter.scheduler.close();
});
}

// ─── delivery.test.ts ───
{
// {§schedule-delivery} — the module inside a real daemon: a session adds a rule through the family
// action, the occurrence fires, and the target session's log carries the message as an arrival row
// from `schedule://<alias>` ({§message-arrival}); the family's list names the next occurrence.











const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);
const FIRST = Date.UTC(2026, 8, 16, 12, 30, 16);

interface LogRow { readonly op: string; readonly origin: string; readonly source: string | null; readonly attrs: string }

const assertDelivery = async (sessionName: string): Promise<void> => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { openMigrated, insertWorkspace, insertSession, rootWorkspace }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_mock.ts")),
        import(join(SERVICE, "test/intg/_db.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [makeMockResponse("````SEND\nBeat taken.\n````", 10)],
    });
    // {§test-artifact-retention} — this lane's run directory, beside every other harness's.
    const db = await openMigrated(join(await testArtifactDirectory("schedule"), `db-${crypto.randomUUID()}.db`));
    const root = await mkdtemp(join(tmpdir(), "plurnk-schedule-"));
    const workspaceId = await insertWorkspace(db, "scheduled");
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId, null, sessionName, "model");

    let now = NOW;
    const armed = new Map<number, () => void>();
    let nextTimer = 1;
    const timers: SchedulerTimers = {
        set: (callback) => { const id = nextTimer++; armed.set(id, callback); return id; },
        clear: (id) => { armed.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers });
    let port: ApplicationPort | null = null;
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    daemon.registerModule({
        setup: (seam: Parameters<Module["setup"]>[0]) => { module.setup(seam); },
        start: async (seam: ApplicationPort) => { port = seam; await module.start(seam); },
        stop: () => module.stop(),
    }, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const application = port as unknown as ApplicationPort;
        const terminated = new Promise<void>((resolveTerminated) => {
            application.subscribeToEvents((_workspaceId, method) => { if (method === "loop/terminated") resolveTerminated(); });
        });
        const added = await application.invokeModuleAction("workspace.schedule.add", {
            alias: "beat",
            definition: { rule: "FREQ=HOURLY;COUNT=2", target: `session://${sessionName}`, prompt: "Take the beat." },
        }, { scope: "workspace", workspaceId }) as { status: number; alias: string; definition?: { state: string; detail?: { next: string | null; rule: string } } };
        assert.equal(added.status, 201);
        assert.equal(added.alias, "beat");
        assert.equal(added.definition?.state, "active");
        assert.equal(added.definition?.detail?.rule, "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", "the stored rule is canonical");
        assert.equal(added.definition?.detail?.next, "2026-09-16T12:30:16+00:00[UTC]");
        assert.equal(armed.size, 1, "one occurrence armed");

        now = FIRST;
        for (const callback of [...armed.values()]) callback();
        await terminated;

        const rows = await db.test_log_entries_by_loop.all({ loop_id: (await db.test_all_loops.all() as Array<{ id: number; session_id: number }>).find((loop) => loop.session_id === sessionId)!.id }) as LogRow[];
        const arrivals = rows.filter((row) => row.op === "SEND" && row.origin === "_plurnk" && (JSON.parse(row.attrs) as { kind?: string }).kind === "message");
        assert.equal(arrivals.length, 1, "the delivery published exactly one arrival row");
        assert.equal(arrivals[0].source, "schedule://beat", "the arrival names the schedule as its causal source");

        const deadline = Date.now() + 10_000;
        let next: string | null | undefined;
        while (Date.now() < deadline) {
            const listing = await application.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as { definitions: Array<{ alias: string; detail?: { next: string | null } }> };
            next = listing.definitions.find(({ alias }) => alias === "beat")?.detail?.next;
            if (next === "2026-09-16T13:30:16+00:00[UTC]") break;
            await sleep(50);
        }
        assert.equal(next, "2026-09-16T13:30:16+00:00[UTC]", "after the fire the family lists the following occurrence");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

for (const sessionName of ["recipient", "Approach_A"]) {
    test(`{§schedule-delivery} a scheduled message reaches ${sessionName} as an arrival from schedule://<alias>`, { timeout: 60_000 }, async () => {
        await assertDelivery(sessionName);
    });
}
}
