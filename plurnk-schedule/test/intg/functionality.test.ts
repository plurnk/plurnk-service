// {§schedule-family} — the adapter's truth against fake time: the environment's rules, discovery
// that tells the time ({§schedule-clock}), admission that canonicalizes and bounds a rule,
// preparation outcomes, timers that deliver through the port ({§schedule-delivery}), failures that
// hold until enable, and residency across teardown ({§schedule-residency}).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import ScheduleFunctionality, { ScheduleFunctionalityError, type FunctionalityFamilyHandle } from "../../src/Functionality.ts";
import type { DeliveryPort, SchedulerTimers } from "../../src/Scheduler.ts";

// 2026-09-16 12:30:15.250 UTC.
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);
const SECOND = 1000;
const HOUR = 3_600_000;
const FIRST = Date.UTC(2026, 8, 16, 12, 30, 16);
const MAX_DELAY_MS = 2_147_483_647;

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
    workers: { id: number; name: string }[] = [{ id: 7, name: "bot" }];
    readonly deliveries: object[] = [];
    refusal: Error | null = null;

    async listWorkers(): Promise<readonly { id: number; name: string }[]> {
        return this.workers;
    }

    async runLoop(args: object): Promise<unknown> {
        if (this.refusal !== null) throw this.refusal;
        this.deliveries.push(args);
        return { status: 200, action: "enqueued_new_loop", loopId: this.deliveries.length };
    }
}

const preparation = (
    workspaceId: number,
    enabled: Record<string, object>,
    options: { previous?: unknown; failure?: "publish-unavailable" | "reject"; force?: string } = {},
) => ({
    workspaceId,
    enabled: new Map(Object.entries(enabled)),
    previous: options.previous ?? null,
    failure: options.failure ?? "publish-unavailable",
    ...(options.force === undefined ? {} : { force: options.force }),
    retain: () => () => {},
});

const problemOf = async (run: () => Promise<unknown>): Promise<{ type: string; status: number; detail: string; errors?: unknown }> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ScheduleFunctionalityError, `expected a ScheduleFunctionalityError, got ${String(error)}`);
        return error.problem as { type: string; status: number; detail: string; errors?: unknown };
    }
    assert.fail("expected a Problem");
};

const HEARTBEAT = { rule: "FREQ=HOURLY", target: "worker://bot", prompt: "Check in." };
const BEAT = { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat.", policy: { proposals: "accept" } };

const family = (time: FakeTime, env: Record<string, string> = {}, reports: string[] = []): ScheduleFunctionality =>
    new ScheduleFunctionality({ TZ: "UTC", ...env }, { clock: time.clock, timers: time.api, report: (message) => { reports.push(message); } });

const attached = (adapter: ScheduleFunctionality, zone = "UTC"): number[] => {
    const refreshed: number[] = [];
    const handle: FunctionalityFamilyHandle = {
        invoke: async () => { throw new Error("not invoked in this test"); },
        refresh: async ({ workspaceId }) => { refreshed.push(workspaceId); },
    };
    adapter.attach(handle, {
        readWorkspaceEnvironment: async () => (ambient) => ({ ...ambient, TZ: zone }),
        // The invoking Worker's own override sits above the workspace layer.
        readWorkerEnvironment: async () => (ambient) => ({ ...ambient, TZ: "Asia/Tokyo" }),
    });
    return refreshed;
};

test("{§schedule-environment} environment definitions are the service baseline with PLURNK_SCHEDULE_ENABLED as the newborn default", async () => {
    const adapter = family(new FakeTime(), {
        PLURNK_SCHEDULE_HEARTBEAT: JSON.stringify(HEARTBEAT),
        PLURNK_SCHEDULE_NIGHTLY: JSON.stringify({ rule: "FREQ=DAILY", target: "worker://janitor", prompt: "Tidy." }),
        PLURNK_SCHEDULE_ENABLED: '["heartbeat"]',
    });
    assert.deepEqual(await adapter.available(), [
        { alias: "heartbeat", definition: { ...HEARTBEAT, rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY" }, enabled: true },
        { alias: "nightly", definition: { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=DAILY", target: "worker://janitor", prompt: "Tidy." }, enabled: false },
    ]);
    assert.throws(() => family(new FakeTime(), { PLURNK_SCHEDULE_BROKEN: JSON.stringify({ ...HEARTBEAT, rule: "FREQ=DAILY;BOGUS=1" }) }), /PLURNK_SCHEDULE_BROKEN: The rule is not a readable RFC 5545 recurrence: RRULE has no part named BOGUS/u);
    assert.throws(() => new ScheduleFunctionality({}), /TZ is unset/u);
});

test("{§schedule-clock} discovery tells the time beside the rule it reads, in the effective zone, and persists nothing", async () => {
    const adapter = family(new FakeTime());
    assert.deepEqual(await adapter.discover({ source: "FREQ=HOURLY;COUNT=2" }, { workspaceId: 1 }), [{
        alias: "hourly",
        summary: "now 2026-09-16T12:30:15+00:00[UTC]; every hour for 2 times; next 2026-09-16T12:30:16+00:00[UTC], 2026-09-16T13:30:16+00:00[UTC]",
        definition: { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2" },
        provenance: { kind: "rule", source: "FREQ=HOURLY;COUNT=2" },
    }]);
    const [tokyo] = await adapter.discover({ source: "FREQ=DAILY" }, { workspaceId: 1 }, { env: { TZ: "Asia/Tokyo" } });
    assert.equal(
        tokyo!.summary,
        "now 2026-09-16T21:30:15+09:00[Asia/Tokyo]; every day at 9:30:16 PM; next 2026-09-16T21:30:16+09:00[Asia/Tokyo], 2026-09-17T21:30:16+09:00[Asia/Tokyo], 2026-09-18T21:30:16+09:00[Asia/Tokyo]; unbounded: add needs COUNT or UNTIL",
    );
    assert.equal((await problemOf(() => adapter.discover({}, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/source-required");
    assert.equal((await problemOf(() => adapter.discover({ query: "daily" }, { workspaceId: 1 }))).status, 400);
    assert.equal((await problemOf(() => adapter.discover({ configuration: { TZ: "UTC" } }, { workspaceId: 1 }))).status, 400);
    assert.equal((await problemOf(() => adapter.discover({ source: "FREQ=DAILY" }, { workspaceId: 1 }, { env: { TZ: "Mars/Olympus" } }))).type, "https://problems.plurnk.xyz/schedule/functionality/zone-unknown");
    assert.equal((await problemOf(() => adapter.discover({ source: "FREQ=DAILY;BOGUS=1" }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/rule-invalid");
});

test("{§schedule-bound} admission canonicalizes the rule in the workspace's zone and refuses an unbounded one", async () => {
    const adapter = family(new FakeTime());
    attached(adapter, "Europe/Paris");
    assert.deepEqual(await adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat." } }, { workspaceId: 1 }), {
        alias: "beat",
        definition: { rule: "DTSTART;TZID=Europe/Paris:20260916T143016\nRRULE:FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat." },
    });
    const called = await adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat." } }, { workspaceId: 1 }, "operation", { env: { TZ: "UTC" } });
    assert.equal((called.definition as { rule: string }).rule, "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", "a call's own TZ wins for that call");
    const byWorker = await adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat." } }, { workspaceId: 1, workerId: 7 }, "operation");
    assert.equal((byWorker.definition as { rule: string }).rule, "DTSTART;TZID=Asia/Tokyo:20260916T213016\nRRULE:FREQ=HOURLY;COUNT=2", "the invoking Worker's own TZ override wins over the workspace layer");
    const [preview] = await adapter.discover({ source: "FREQ=DAILY;COUNT=1" }, { workspaceId: 1, workerId: 7 });
    assert.match(preview!.summary ?? "", /^now 2026-09-16T21:30:15\+09:00\[Asia\/Tokyo\]/u, "the Worker reads the time in its own zone");
    assert.equal((await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY", target: "worker://bot", prompt: "Beat." } }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/rule-unbounded");
    assert.equal((await problemOf(() => adapter.admit({ definition: HEARTBEAT }, { workspaceId: 1 }))).type, "https://problems.plurnk.xyz/schedule/functionality/alias-required");
    const invalid = await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=1", target: "agent://bot", prompt: "Beat." } }, { workspaceId: 1 }));
    assert.equal(invalid.type, "https://problems.plurnk.xyz/schedule/functionality/definition-invalid");
    assert.ok(Array.isArray(invalid.errors) && invalid.errors.length > 0, "the schema errors ride along");
    assert.equal((await problemOf(() => adapter.admit({ alias: "beat", definition: { rule: "FREQ=HOURLY;COUNT=1", target: "worker://bot", prompt: "Beat.", policy: { proposals: "maybe" } } }, { workspaceId: 1 }))).status, 400);
});

test("{§schedule-residency} preparation publishes one outcome per rule, commit arms, teardown leaves the timers armed", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const exhausted = { rule: "DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY;COUNT=1", target: "worker://bot", prompt: "Once." };
    const heartbeat = { ...HEARTBEAT, rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY" };
    const prepared = await adapter.prepare(preparation(1, { heartbeat, beat: BEAT, once: exhausted }));
    assert.deepEqual(prepared.documents, []);
    assert.deepEqual(prepared.outcomes.get("beat"), {
        state: "active",
        detail: {
            rule: BEAT.rule,
            zone: "UTC",
            text: "every hour for 2 times",
            next: "2026-09-16T12:30:16+00:00[UTC]",
            exhausted: false,
            target: "worker://bot",
            policy: { proposals: "accept" },
        },
    });
    assert.deepEqual(prepared.outcomes.get("heartbeat"), {
        state: "active",
        detail: { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY", zone: "UTC", text: "every hour", next: "2026-09-16T12:30:16+00:00[UTC]", exhausted: false, target: "worker://bot" },
    });
    assert.deepEqual(prepared.outcomes.get("once"), {
        state: "active",
        detail: { rule: exhausted.rule, zone: "UTC", text: "every day at 9 AM for 1 time", next: null, exhausted: true, target: "worker://bot" },
    });
    assert.deepEqual(adapter.scheduler.armed(1), [], "nothing arms before commit");
    await prepared.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat", "heartbeat"], "an exhausted rule arms nothing");
    assert.deepEqual(time.delays(), [FIRST - NOW, FIRST - NOW]);
    await adapter.teardown(prepared.snapshot, { workspaceId: 1 });
    assert.deepEqual(adapter.scheduler.armed(1), ["beat", "heartbeat"], "cooling keeps the obligation");
    const narrowed = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: prepared.snapshot }));
    await narrowed.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat"], "disable and remove disarm through the published set");
    const emptied = await adapter.prepare(preparation(1, {}, { previous: narrowed.snapshot }));
    await emptied.commit();
    assert.deepEqual(adapter.scheduler.armed(1), []);
    assert.deepEqual(time.delays(), []);
});

test("an unreadable enabled definition is unavailable with its Problem, and rejects only an add that introduces it", async () => {
    const reports: string[] = [];
    const adapter = family(new FakeTime(), {}, reports);
    const broken = { rule: "FREQ=DAILY;BOGUS=1", target: "worker://bot", prompt: "x" };
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

test("{§schedule-delivery} an occurrence delivers the message to the target worker as an arrival from schedule://<alias>, then the next one arms", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    const refreshed = attached(adapter);
    const port = new FakePort();
    adapter.scheduler.start(port);
    await (await adapter.prepare(preparation(3, { beat: BEAT }))).commit();
    await time.advance(FIRST);
    assert.deepEqual(port.deliveries, [{ workspaceId: 3, workerId: 7, prompt: "Beat.", source: "schedule://beat", policy: { proposals: "accept" } }]);
    assert.deepEqual(refreshed, [3], "a settled delivery republishes the outcomes");
    assert.deepEqual(time.delays(), [HOUR], "the next occurrence armed from the fire");
    const republished = await adapter.prepare(preparation(3, { beat: BEAT }));
    assert.equal((republished.outcomes.get("beat") as { detail: { next: string } }).detail.next, "2026-09-16T13:30:16+00:00[UTC]");
    await republished.commit();
    await time.advance(FIRST + HOUR);
    assert.equal(port.deliveries.length, 2);
    assert.deepEqual(adapter.scheduler.armed(3), [], "the rule is exhausted");
    const done = await adapter.prepare(preparation(3, { beat: BEAT }));
    assert.deepEqual((done.outcomes.get("beat") as { detail: { next: null; exhausted: boolean } }).detail, {
        rule: BEAT.rule, zone: "UTC", text: "every hour for 2 times", next: null, exhausted: true, target: "worker://bot", policy: { proposals: "accept" },
    });
    await adapter.scheduler.close();
});

test("{§schedule-delivery} a late fire delivers once and skips what it missed; a far occurrence arms in hops", async () => {
    const time = new FakeTime();
    const adapter = family(time);
    attached(adapter);
    const port = new FakePort();
    adapter.scheduler.start(port);
    const hourly = { rule: "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=10", target: "worker://bot", prompt: "Tick." };
    await (await adapter.prepare(preparation(1, { hourly }))).commit();
    await time.advance(FIRST + 3 * HOUR + SECOND);
    assert.equal(port.deliveries.length, 1, "no backlog");
    assert.deepEqual(time.delays(), [HOUR - SECOND], "armed for the first occurrence after now");
    const far = { rule: "DTSTART;TZID=UTC:20270101T000000\nRRULE:FREQ=YEARLY;COUNT=1", target: "worker://bot", prompt: "Happy new year." };
    await (await adapter.prepare(preparation(2, { far }))).commit();
    assert.deepEqual(time.delays().filter((delay) => delay === MAX_DELAY_MS), [MAX_DELAY_MS], "setTimeout's ceiling is one hop");
    await time.advance(time.now + MAX_DELAY_MS);
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
    port.workers = [];
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
    assert.equal(outcome.problem.detail, "No worker named 'bot' exists in this workspace.");
    await held.commit();
    assert.deepEqual(adapter.scheduler.armed(1), [], "republishing does not retry on its own");

    port.workers = [{ id: 7, name: "bot" }];
    const forced = await adapter.prepare(preparation(1, { beat: BEAT }, { previous: held.snapshot, force: "beat" }));
    assert.equal(forced.outcomes.get("beat")?.state, "active", "enable retries");
    await forced.commit();
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
    await replaced.commit();
    assert.deepEqual(adapter.scheduler.armed(1), ["beat"]);
    await adapter.scheduler.close();
});
