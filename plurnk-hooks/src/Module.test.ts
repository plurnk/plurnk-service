import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredModule, withEnvironment } from "../test/environment.ts";
import { commandFixture } from "../test/command.ts";
import { UNKNOWN_POSITION, type ApplicationOperationEvent, type ProposalProjection } from "@plurnk/plurnk-contracts";
import EventProjection from "./EventProjection.ts";
import { hookConfig } from "./config.ts";

// ─── Module.test.ts ───
{
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

test("{§hooks-event-projection} common hook names retain native evidence without inferring sessions", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hook-projection-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = join(root, "events.jsonl");
    const module = configuredModule({
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify(["--input-type=module", "-e", 'import { appendFile } from "node:fs/promises"; let body = ""; for await (const chunk of process.stdin) body += chunk; await appendFile(process.argv[1], body);', output]),
        PLURNK_HOOKS_EVENTS: "Stop,Notification,PermissionRequest",
    });
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(null, "workspace/created", { id: 42 });
    fixture.emit(42, "loop/packet", { sessionId: 7, loopId: 9, packetCount: 3 });
    const terminal = { sessionId: 7, loopId: 9, result: { status: 200 } };
    fixture.emit(42, "loop/terminated", terminal);
    const notice = { sessionId: null, loopId: 0, notice: { source: "fixture", level: "warn", message: "Preparation incomplete." } };
    fixture.emit(42, "notice/event", notice);
    const interaction = { sessionId: 7, loopId: 10, turnId: 11, interactionId: 12, request: { toolName: "question", mode: "form", message: "Please choose.", requestedSchema: { type: "object" } } };
    fixture.emit(42, "loop/interaction", interaction);
    await module.close();
    const events = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events, [
        { hook_event_name: "Stop", session_id: "7", plurnk: { workspaceId: 42, method: "loop/terminated", params: terminal } },
        { hook_event_name: "Notification", message: "Preparation incomplete.", plurnk: { workspaceId: 42, method: "notice/event", params: notice } },
        { hook_event_name: "PermissionRequest", session_id: "7", tool_name: "question", tool_input: interaction.request, message: "Please choose.", plurnk: { workspaceId: 42, method: "loop/interaction", params: interaction } },
    ]);
});

test("{§hooks-event-projection} selected events reach one no-shell command as exact JSON stdin", async () => {
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
            PLURNK_HOOKS_EVENTS: "Stop",
            PLURNK_HOOKS_TIMEOUT_MS: "30000",
            HOOK_FIXTURE_MARKER: "resolved environment",
        });
        const fixture = seamFixture();
        module.start(fixture.seam);
        fixture.emit(42, "notice/event", { loopId: 9 });
        fixture.emit(42, "loop/terminated", {
            sessionId: 7,
            loopId: 9,
            result: { status: 200 },
        });
        await module.close();

        const captured = JSON.parse(await readFile(output, "utf8")) as { argv: string[]; input: string; marker: string };
        assert.equal(captured.marker, "resolved environment", "configuration and child process use the same resolved environment");
        assert.deepEqual(captured.argv, [`literal;touch ${shellSideEffect}`]);
        assert.equal(existsSync(shellSideEffect), false);
        assert.equal(captured.input, `${JSON.stringify({
            hook_event_name: "Stop",
            session_id: "7",
            plurnk: {
                workspaceId: 42,
                method: "loop/terminated",
                params: {
                    sessionId: 7,
                    loopId: 9,
                    result: { status: 200 },
                },
            },
        })}\n`);
        assert.equal(fixture.subscribed(), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§hooks-module} a broken stdin does not release ownership before the hook process closes", { timeout: 10_000 }, async (t) => {
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
        PLURNK_HOOKS_EVENTS: "Stop",
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    }, () => undefined);
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(1, "loop/terminated", { body: "x".repeat(2 * 1024 * 1024) });
    await module.close();
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (cause: NodeJS.ErrnoException) => cause.code === "ESRCH", "close must await its child, including after stdin fails");
});

test("{§hooks-module} command failures are reported after the event source returns", async () => {
    const reports: Array<{ message: string; cause: unknown }> = [];
    const module = configuredModule({
        PLURNK_HOOKS_COMMAND: "/missing/plurnk-hook",
        PLURNK_HOOKS_EVENTS: "Notification",
        PLURNK_HOOKS_TIMEOUT_MS: "30000",
    }, (message, cause) => { reports.push({ message, cause }); });
    const fixture = seamFixture();
    module.start(fixture.seam);

    assert.doesNotThrow(() => fixture.emit(4, "notice/event", { loopId: 3, notice: { message: "Fixture notice" } }));
    await module.close();

    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /hook command failed for Notification/);
    assert.ok(reports[0].cause instanceof Error);
});

test("{§hooks-module} nonzero exits and delivery timeouts are reported", async (t) => {
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
                PLURNK_HOOKS_EVENTS: "Stop",
                PLURNK_HOOKS_TIMEOUT_MS: specimen.timeout,
            }, (message, cause) => { reports.push({ message, cause }); });
            const fixture = seamFixture();
            module.start(fixture.seam);
            fixture.emit(2, "loop/terminated", { sessionId: 3, loopId: 4 });
            await module.close();

            assert.equal(reports.length, 1);
            assert.match(reports[0].message, /hook command failed for Stop/);
            assert.match(String(reports[0].cause), specimen.cause);
        });
    }
});

test("{§hooks-module} an unconfigured hooks module does not subscribe", () => {
    const module = configuredModule({});
    const fixture = seamFixture();
    module.start(fixture.seam);
    assert.equal(fixture.subscribed(), false);
});

test("{§hooks-module} close drains FIFO deliveries without mutating captured event payloads", { timeout: 10_000 }, async (t) => {
    const command = await commandFixture(t);
    const failures: unknown[] = [];
    const module = configuredModule(command.env, (_message, cause) => failures.push(cause));
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    fixture.emit(42, "loop/terminated", { id: 1 });
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
        { hook_event_name: "Stop", plurnk: { workspaceId: 42, method: "loop/terminated", params: { id: 1 } } },
        { hook_event_name: "Stop", plurnk: { workspaceId: 42, method: "loop/terminated", params: { id: 2, text: "at publication" } } },
        { hook_event_name: "Stop", plurnk: { workspaceId: 42, method: "loop/terminated", params: { id: 3 } } },
    ]);
});

test("{§hooks-module} finite concurrency and queue capacity report excess events without blocking dispatch", { timeout: 10_000 }, async (t) => {
    const command = await commandFixture(t);
    const failures: unknown[] = [];
    const module = configuredModule({ ...command.env, PLURNK_HOOKS_CONCURRENCY: "2", PLURNK_HOOKS_QUEUE_LIMIT: "1" }, (_message, cause) => failures.push(cause));
    t.after(() => module.close());
    const fixture = seamFixture();
    module.start(fixture.seam);
    for (const id of [1, 2, 3, 4]) assert.doesNotThrow(() => fixture.emit(42, "loop/terminated", { id }));
    await command.waitFor(2);
    assert.deepEqual(command.events.map(({ plurnk }) => plurnk.params.id).toSorted((a, b) => a - b), [1, 2]);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /queue is full; event not delivered/);
    command.release(1);
    await command.waitFor(3);
    assert.equal(command.events[2].plurnk.params.id, 3, "the oldest queued event starts when a slot is released");
    command.release(2);
    command.release(3);
    await module.close();
    assert.equal(command.events.length, 3, "an excess event is never silently retried");
});

test("{§hooks-module} queued deliveries retain their admission deadline", { timeout: 10_000 }, async (t) => {
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

test("{§hooks-module} serialization and reporter failures preserve both causes without escaping the observer", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const reporterFailure = new Error("diagnostic sink unavailable");
    const module = configuredModule({ PLURNK_HOOKS_COMMAND: "/must-not-run", PLURNK_HOOKS_EVENTS: "Stop" }, () => { throw reporterFailure; });
    const fixture = seamFixture();
    module.start(fixture.seam);
    const params: Record<string, unknown> = {};
    params.self = params;
    assert.doesNotThrow(() => fixture.emit(42, "loop/terminated", params));
    await module.close();
    assert.equal(diagnostics.length, 1);
    const aggregate = diagnostics[0][1];
    assert.ok(aggregate instanceof AggregateError);
    assert.ok(aggregate.errors[0] instanceof TypeError);
    assert.match(aggregate.errors[0].message, /circular/i);
    assert.equal(aggregate.errors[1], reporterFailure);
});
}

// ─── EventProjection.test.ts ───
{
const started: ApplicationOperationEvent = {
    sessionId: 7, loopId: 9, turnId: 11, sequence: 2, origin: "model", projectRoot: "/project", phase: "started",
    statement: { op: "READ", target: { kind: "local", raw: "README.md" },
        aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION },
};

test("{§hooks-event-projection} operation phase/status select hooks without treating system observations as tools", () => {
    for (const origin of ["model", "client", "_plurnk"] as const) {
        for (const status of [200, 202, 400, 499]) {
            const result = { status, detail: "Exact fixture result" };
            const params = { ...started, origin, phase: "settled" as const, result };
            const event = EventProjection.project(42, "operation/event", params);
            if (origin === "_plurnk") {
                assert.equal(event, null);
                continue;
            }
            assert.deepEqual(event, {
                hook_event_name: status >= 400 ? "PostToolUseFailure" : "PostToolUse",
                session_id: "7", cwd: "/project", tool_use_id: "11/2", tool_name: "READ",
                tool_input: started.statement, tool_response: result,
                plurnk: { workspaceId: 42, method: "operation/event", params },
            });
        }
    }
    const headless = EventProjection.project(42, "operation/event", { ...started, projectRoot: null });
    assert.equal(headless?.hook_event_name, "PreToolUse");
    assert.equal(Object.hasOwn(headless, "cwd"), false);
    assert.equal(Object.hasOwn(headless, "tool_response"), false);
    assert.equal(EventProjection.project(42, "log/entry", { entry: { op: "READ" } }), null);
    assert.equal(EventProjection.project(42, "stream/concluded", { result: { status: 200 } }), null);
});

test("{§hooks-event-projection} only client-owned proposals request permission", () => {
    const proposal: ProposalProjection = { logEntryId: 12, sessionId: 7, session: "client", loopId: 9, turnId: 11, coordinate: "1/1/12", op: "sh",
        target: { scheme: "exec", authority: "sh", pathname: "" }, body: "echo 42", attrs: {},
        owner: "acp://operator/threads/client", disposition: { decision: "review" } };
    const event = EventProjection.project(42, "loop/proposal", proposal);
    assert.equal(event?.hook_event_name, "PermissionRequest");
    assert.equal(event?.tool_name, "sh");
    assert.deepEqual(event?.tool_input, { target: proposal.target, body: proposal.body, attrs: proposal.attrs });
    for (const decision of ["accept", "reject"] as const) {
        assert.equal(EventProjection.project(42, "loop/proposal", { ...proposal, disposition: { decision } }), null);
    }
});
}

// ─── config.test.ts ───
{
const read = (env: NodeJS.ProcessEnv = {}) => withEnvironment(env, hookConfig);
const selected = { PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_EVENTS: "Stop" };

test("{§hooks-module} hook configuration is absent until an exact command and event selection are declared", () => {
    assert.equal(read(), null);
    assert.throws(
        () => read({ PLURNK_HOOKS_COMMAND: "notify-send" }),
        { name: "ConfigurationError", key: "PLURNK_HOOKS_EVENTS", message: /PLURNK_HOOKS_EVENTS must select at least one event/ },
    );
    for (const companion of [{ PLURNK_HOOKS_EVENTS: "Stop" }, { PLURNK_HOOKS_ARGS: "[]" }]) {
        assert.throws(() => read(companion), { name: "ConfigurationError", key: "PLURNK_HOOKS_COMMAND", message: /has companions but no PLURNK_HOOKS_COMMAND/ });
    }
});

test("{§hooks-module} production configuration preserves executable paths with spaces and exact JSON argv", () => {
    assert.deepEqual(read({
        PLURNK_HOOKS_COMMAND: "/opt/local tools/hook",
        PLURNK_HOOKS_ARGS: '["/opt/hooks/notify.mjs","literal;not-shell"]',
        PLURNK_HOOKS_EVENTS: "Stop, Notification",
        PLURNK_HOOKS_TIMEOUT_MS: "1200",
        PLURNK_HOOKS_CONCURRENCY: "2",
        PLURNK_HOOKS_QUEUE_LIMIT: "0",
    }), {
        command: "/opt/local tools/hook",
        args: ["/opt/hooks/notify.mjs", "literal;not-shell"],
        events: new Set(["Stop", "Notification"]),
        timeoutMs: 1200,
        concurrency: 2,
        queueLimit: 0,
    });
    assert.deepEqual(read(selected)?.args, []);
});

test("{§hooks-event-projection} selection uses exact supported hook names and diagnoses any other name", () => {
    const names = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "Notification", "PermissionRequest"];
    assert.deepEqual(read({ ...selected, PLURNK_HOOKS_EVENTS: names.join(",") })?.events, new Set(names));
    for (const events of ["Notice*", "notice", "Stop,", "Pre ToolUse", "Notification,Notification", "SessionStart", "UserPromptSubmit", "constructor", "__proto__"]) {
        assert.throws(() => read({ ...selected, PLURNK_HOOKS_EVENTS: events }), { name: "ConfigurationError", key: "PLURNK_HOOKS_EVENTS", message: /requires an exact hook name|more than once/ });
    }
});

test("{§hooks-module} malformed argv and invalid delivery bounds fail configuration", () => {
    for (const args of ["--quiet", "{}", "[42]", "null"]) {
        assert.throws(() => read({ ...selected, PLURNK_HOOKS_ARGS: args }), { name: "ConfigurationError", key: "PLURNK_HOOKS_ARGS", message: /PLURNK_HOOKS_ARGS must be a JSON array of strings/ });
    }
    for (const [name, invalid] of [
        ["PLURNK_HOOKS_TIMEOUT_MS", ["0", "-1", "", "1.5", "never"]],
        ["PLURNK_HOOKS_CONCURRENCY", ["0", "-1", "", "1.5"]],
        ["PLURNK_HOOKS_QUEUE_LIMIT", ["-1", "", "1.5"]],
    ] as const) {
        for (const value of invalid) {
            assert.throws(() => read({ ...selected, [name]: value }), { name: "ConfigurationError", key: name, message: new RegExp(`${name} must be a safe integer`) });
        }
        withEnvironment(selected, () => {
            delete process.env[name];
            assert.throws(hookConfig, new RegExp(`${name} is missing from the assembled environment floor`));
        });
    }
});
}
