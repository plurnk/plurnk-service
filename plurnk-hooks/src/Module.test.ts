import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredModule } from "../test/environment.ts";
import { commandFixture } from "../test/command.ts";

interface SeamFixture {
    readonly seam: {
        subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
    };
    emit(workspaceId: number | null, method: string, params: unknown): void;
    subscribed(): boolean;
}

const seamFixture = (): SeamFixture => {
    let handler: ((workspaceId: number | null, method: string, params: unknown) => void) | null = null;
    return {
        seam: {
            subscribeToEvents(next) {
                handler = next;
                return () => { handler = null; };
            },
        },
        emit(workspaceId, method, params) {
            if (handler === null) throw new Error("fixture has no event subscriber");
            handler(workspaceId, method, params);
        },
        subscribed: () => handler !== null,
    };
};

test("[{§hooks-command-delivery}] selected events reach one no-shell command as exact JSON stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-"));
    try {
        const script = join(root, "capture.mjs");
        const output = join(root, "captured.json");
        const shellSideEffect = join(root, "must-not-exist");
        await writeFile(script, [
            'import { writeFile } from "node:fs/promises";',
            'let input = "";',
            'process.stdin.setEncoding("utf8");',
            'for await (const chunk of process.stdin) input += chunk;',
            'await writeFile(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), input, marker: process.env.HOOK_FIXTURE_MARKER }));',
        ].join("\n"));

        const module = configuredModule({
            PLURNK_HOOKS_COMMAND: process.execPath,
            PLURNK_HOOKS_ARGS: JSON.stringify([
                script,
                output,
                `literal;touch ${shellSideEffect}`,
            ]),
            PLURNK_HOOKS_EVENTS: "loop/terminated",
            PLURNK_HOOKS_TIMEOUT_MS: "30000",
            HOOK_FIXTURE_MARKER: "resolved environment",
        });
        const fixture = seamFixture();
        module.start(fixture.seam);
        fixture.emit(42, "notice/event", { loopId: 9 });
        fixture.emit(42, "loop/terminated", {
            workerId: 7,
            loopId: 9,
            result: { status: 200 },
        });
        await module.close();

        const captured = JSON.parse(await readFile(output, "utf8")) as { argv: string[]; input: string; marker: string };
        assert.equal(captured.marker, "resolved environment", "configuration and child process use the same resolved environment");
        assert.deepEqual(captured.argv, [`literal;touch ${shellSideEffect}`]);
        assert.equal(existsSync(shellSideEffect), false);
        assert.equal(captured.input, `${JSON.stringify({
            workspaceId: 42,
            method: "loop/terminated",
            params: {
                workerId: 7,
                loopId: 9,
                result: { status: 200 },
            },
        })}\n`);
        assert.equal(fixture.subscribed(), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§hooks-failure-isolation} a broken stdin does not release ownership before the hook process closes", { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hook-close-"));
    const pidFile = join(root, "pid");
    t.after(async () => {
        if (existsSync(pidFile)) {
            try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
        }
        await rm(root, { recursive: true, force: true });
    });
    const module = configuredModule({
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify(["-e", `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); require('node:fs').closeSync(0); setInterval(() => {}, 1000);`, pidFile]),
        PLURNK_HOOKS_EVENTS: "loop/terminated",
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    }, () => undefined);
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(1, "loop/terminated", { body: "x".repeat(2 * 1024 * 1024) });
    await module.close();
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (cause: NodeJS.ErrnoException) => cause.code === "ESRCH", "close must await its child, including after stdin fails");
});

test("[{§hooks-failure-isolation}] command failures are reported after the event source returns", async () => {
    const reports: Array<{ message: string; cause: unknown }> = [];
    const module = configuredModule({
        PLURNK_HOOKS_COMMAND: "/missing/plurnk-hook",
        PLURNK_HOOKS_EVENTS: "notice/event",
        PLURNK_HOOKS_TIMEOUT_MS: "30000",
    }, (message, cause) => { reports.push({ message, cause }); });
    const fixture = seamFixture();
    module.start(fixture.seam);

    assert.doesNotThrow(() => fixture.emit(4, "notice/event", { loopId: 3 }));
    await module.close();

    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /hook command failed for notice\/event/);
    assert.ok(reports[0].cause instanceof Error);
});

test("[{§hooks-failure-isolation}] nonzero exits and delivery timeouts are reported", async (t) => {
    for (const specimen of [
        {
            name: "nonzero exit",
            args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(9));"],
            timeout: "30000",
            cause: /exited with status 9/,
        },
        {
            name: "timeout",
            args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
            timeout: "20",
            cause: /aborted/i,
        },
    ]) {
        await t.test(specimen.name, async () => {
            const reports: Array<{ message: string; cause: unknown }> = [];
            const module = configuredModule({
                PLURNK_HOOKS_COMMAND: process.execPath,
                PLURNK_HOOKS_ARGS: JSON.stringify(specimen.args),
                PLURNK_HOOKS_EVENTS: "loop/terminated",
                PLURNK_HOOKS_TIMEOUT_MS: specimen.timeout,
            }, (message, cause) => { reports.push({ message, cause }); });
            const fixture = seamFixture();
            module.start(fixture.seam);
            fixture.emit(2, "loop/terminated", { workerId: 3, loopId: 4 });
            await module.close();

            assert.equal(reports.length, 1);
            assert.match(reports[0].message, /hook command failed for loop\/terminated/);
            assert.match(String(reports[0].cause), specimen.cause);
        });
    }
});

test("an unconfigured hooks module does not subscribe", () => {
    const module = configuredModule({});
    const fixture = seamFixture();
    module.start(fixture.seam);
    assert.equal(fixture.subscribed(), false);
});

test("{§hooks-bounded-delivery} close drains FIFO deliveries without mutating captured event payloads", { timeout: 10_000 }, async (t) => {
    const command = await commandFixture(t);
    const failures: unknown[] = [];
    const module = configuredModule(command.env, (_message, cause) => failures.push(cause));
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(null, "workspace/created", { id: 1 });
    const params = { id: 2, text: "at publication" };
    fixture.emit(42, "loop/terminated", params);
    params.text = "later mutation";
    fixture.emit(42, "loop/terminated", { id: 3 });
    let closed = false;
    const closing = module.close().then(() => { closed = true; });
    assert.equal(fixture.subscribed(), false);
    assert.equal(module.close(), module.close(), "repeated closes join the same drain");
    assert.throws(() => module.start(fixture.seam), /cannot be started again/);
    for (const id of [1, 2, 3]) {
        await command.waitFor(id);
        assert.equal(command.events.length, id, "one executable at a time, including during closure");
        assert.equal(closed, false, "close owns all admitted work");
        command.release(id);
    }
    await closing;
    assert.deepEqual(failures, []);
    assert.deepEqual(command.events, [
        { workspaceId: null, method: "workspace/created", params: { id: 1 } },
        { workspaceId: 42, method: "loop/terminated", params: { id: 2, text: "at publication" } },
        { workspaceId: 42, method: "loop/terminated", params: { id: 3 } },
    ]);
});

test("{§hooks-bounded-delivery} finite concurrency and queue capacity report excess events without blocking dispatch", { timeout: 10_000 }, async (t) => {
    const command = await commandFixture(t);
    const failures: unknown[] = [];
    const module = configuredModule({ ...command.env, PLURNK_HOOKS_CONCURRENCY: "2", PLURNK_HOOKS_QUEUE_LIMIT: "1" }, (_message, cause) => failures.push(cause));
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    for (const id of [1, 2, 3, 4]) assert.doesNotThrow(() => fixture.emit(42, "loop/terminated", { id }));
    await command.waitFor(2);
    assert.deepEqual(command.events.map(({ params }) => params.id).sort(), [1, 2]);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /queue is full; event not delivered/);
    command.release(1);
    await command.waitFor(3);
    assert.equal(command.events[2]!.params.id, 3, "the oldest queued event starts when a slot is released");
    command.release(2);
    command.release(3);
    await module.close();
    assert.equal(command.events.length, 3, "an excess event is never silently retried");
});

test("{§hooks-bounded-delivery} queued deliveries retain their admission deadline", { timeout: 10_000 }, async (t) => {
    const command = await commandFixture(t);
    const failures: unknown[] = [];
    const module = configuredModule(command.env, (_message, cause) => failures.push(cause));
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(42, "loop/terminated", { id: 1 });
    fixture.emit(42, "loop/terminated", { id: 2 });
    await command.waitFor(1);
    const later = Date.now() + 30_001;
    t.mock.method(Date, "now", () => later);
    command.release(1);
    await module.close();
    assert.equal(command.events.length, 1);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /deadline expired in queue; event not delivered/);
});

test("{§hooks-failure-isolation} serialization and reporter failures preserve both causes without escaping the observer", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const reporterFailure = new Error("diagnostic sink unavailable");
    const module = configuredModule({ PLURNK_HOOKS_COMMAND: "/must-not-run", PLURNK_HOOKS_EVENTS: "loop/terminated" }, () => { throw reporterFailure; });
    const fixture = seamFixture();
    module.start(fixture.seam);
    const params: Record<string, unknown> = {};
    params.self = params;
    assert.doesNotThrow(() => fixture.emit(42, "loop/terminated", params));
    await module.close();
    assert.equal(diagnostics.length, 1);
    const aggregate = diagnostics[0]![1];
    assert.ok(aggregate instanceof AggregateError);
    assert.ok(aggregate.errors[0] instanceof TypeError);
    assert.match(aggregate.errors[0].message, /circular/i);
    assert.equal(aggregate.errors[1], reporterFailure);
});
