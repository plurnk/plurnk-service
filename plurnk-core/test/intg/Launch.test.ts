import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Launch, { LaunchError, READINESS_LINE, type LaunchedDaemon } from "../../src/launch/Launch.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Results from "../../src/core/results.ts";
import Daemon from "../../src/server/Daemon.ts";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { parseEnv } from "node:util";
import { parsePath } from "@plurnk/plurnk-parser";
import { isRecord, Validator, type OperationResult, type PlurnkStatement, TurnDisposition } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import { liveWorkspace } from "../_live-harness.ts";
import { readStmt, findStmt, editStmt, copyStmt, moveStmt, killStmt } from "./_dsl.ts";
import { lastReply } from "./_packet.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitFor, waitForDb, withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { createHash, randomBytes } from "node:crypto";
import { Module as AuthModule } from "@plurnk/plurnk-auth";
import { bindListener } from "./_http.ts";
import { type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { TracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { recordGenAiSpans } from "../fixtures/genai-spans.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";

describe("Launch", () => {
// {§startup-admission} — the service's launcher against the real entry: readiness by the published
// line, a private state root, stop-and-wait, and every way a start can fail without touching
// state or leaving a process behind.










const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
// Only the resolution mode crosses into spawned daemons, never the harness's own --import flags.
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));
const COMMAND = [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"];

const daemonEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
    };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_DB_PATH;
    return env;
};

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    await new Promise<void>((accept) => server.close(() => accept()));
    return address.port;
};

test("{§startup-admission} {§host-path-layout}: a private daemon publishes its address, roots its database under the state root, and stops on request", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-"));
    // A root with a space: the readiness line carries the path as a JSON string, so it parses exact.
    const root = join(home, "private workspace");
    let first: LaunchedDaemon | undefined;
    try {
        first = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/acp$/u);
        assert.equal(first.host, "127.0.0.1");
        assert.ok(first.port > 0);
        assert.equal(first.dbPath, join(root, "data", "plurnk", "plurnk.db"), "the database lives under the state root, never under XDG_DATA_HOME");
        assert.equal(first.route, "no model", "a modelless boot is still a ready daemon");
        assert.ok(READINESS_LINE.test(first.stdout()), "the readiness line is the contract the helper parsed");
        assert.equal(await exists(join(home, ".local", "share", "plurnk")), false, "nothing under the XDG data home");
        const response = await fetch(first.url);
        assert.notEqual(response.status, 503, "after readiness the listener is past service-starting");
        const stopped = await first.stop();
        assert.deepEqual(stopped, { code: 0, signal: null }, "SIGTERM is a clean teardown");
        assert.deepEqual(await first.stop(), stopped, "stop is idempotent");
        assert.ok(await exists(first.dbPath), "stopping keeps the state root: retention is the launcher's decision");

        // {§host-path-layout}: the same root re-enters the same workspace.
        const second = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        try {
            assert.equal(second.dbPath, first.dbPath);
        } finally { await second.stop(); }
    } finally {
        await first?.stop();
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission} {§startup-admission}: an occupied address is an exit before readiness, with the state root untouched", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-occupied-"));
    const root = join(home, "private");
    const squatter = createServer((_request, response) => { response.statusCode = 200; response.end("not plurnk"); });
    try {
        await new Promise<void>((accept) => squatter.listen(0, "127.0.0.1", accept));
        const address = squatter.address();
        if (address === null || typeof address === "string") throw new Error("no TCP address");
        await assert.rejects(
            Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: address.port, readyTimeoutMs: 60_000, stopGraceMs: 5_000 }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "exited", "the daemon lost the bind and said so by exiting");
                assert.notEqual(error.code, 0);
                assert.match(error.stderr, /EADDRINUSE|address/u, "the stderr carries the originating address error");
                return true;
            },
        );
        assert.equal(await exists(root), false, "a lost bind race touches no durable state: the launcher decides nothing about the root");
    } finally {
        await new Promise<void>((accept) => squatter.close(() => accept()));
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission}: two simultaneous starters on one address — one is ready, the other exits", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-race-"));
    const port = await freePort();
    try {
        const settled = await Promise.allSettled([1, 2].map((n) =>
            Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: join(home, `private-${n}`), host: "127.0.0.1", port, readyTimeoutMs: 60_000, stopGraceMs: 5_000 })));
        const ready = settled.filter((result) => result.status === "fulfilled");
        const lost = settled.filter((result) => result.status === "rejected");
        assert.equal(ready.length, 1, "exactly one daemon owns the address");
        assert.equal(lost.length, 1);
        assert.ok(lost[0].status === "rejected" && lost[0].reason instanceof LaunchError && lost[0].reason.kind === "exited");
        for (const result of ready) if (result.status === "fulfilled") await result.value.stop();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission}: a start that never becomes ready is stopped, awaited and reported as a timeout, leaving no process", { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-timeout-"));
    try {
        let child: ChildProcess | undefined;
        await assert.rejects(
            Launch.start({
                command: [process.execPath, "-e", "process.stdout.write('starting but never ready\\n'); setTimeout(() => {}, 60_000)"],
                env: daemonEnv(home), readyTimeoutMs: 1_000, stopGraceMs: 1_000,
                onOutput: () => {},
            }).then((daemon) => { child = daemon.child; return daemon; }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "timeout");
                assert.match(error.stdout, /starting but never ready/u, "what the process did say is carried");
                return true;
            },
        );
        assert.equal(child, undefined, "a timed-out start never hands out a daemon; the helper stopped and awaited it before throwing");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission}: an executable that cannot be spawned is a spawn failure, not a hang", { timeout: 30_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-spawn-"));
    try {
        await assert.rejects(
            Launch.start({ command: [join(home, "no-such-executable"), "start"], env: daemonEnv(home), readyTimeoutMs: 5_000, stopGraceMs: 1_000 }),
            (error: unknown) => error instanceof LaunchError && error.kind === "spawn",
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission}: an IPv6 host is bracketed in the published URL and parsed back as the host", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-v6-"));
    try {
        const daemon = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: join(home, "private"), host: "::1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        try {
            assert.match(daemon.url, /^http:\/\/\[::1\]:\d+\/acp$/u);
            assert.equal(daemon.host, "[::1]");
            assert.ok(daemon.port > 0);
            const response = await fetch(daemon.url);
            assert.notEqual(response.status, 503);
        } finally { await daemon.stop(); }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const untilGone = async (pid: number, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (alive(pid)) {
        if (Date.now() > deadline) return false;
        await new Promise((accept) => setTimeout(accept, 100));
    }
    return true;
};

test("{§startup-admission}: a shared daemon logs to its file, is released at readiness, and survives the launcher that started it", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-shared-"));
    const logFile = join(home, "service.log");
    const launcher = join(home, "launcher.mjs");
    let pid: number | undefined;
    try {
        // The launcher is a separate process that starts a shared daemon and exits without stopping it.
        const options = { command: COMMAND, env: daemonEnv(home), stateRoot: join(home, "private"), lifetime: "shared", logFile, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 };
        await writeFile(launcher, [
            `import Launch from ${JSON.stringify(pathToFileURL(resolve(here, "../../src/launch/Launch.ts")).href)};`,
            `const daemon = await Launch.start(${JSON.stringify(options)});`,
            "process.stdout.write(JSON.stringify({ pid: daemon.child.pid, url: daemon.url, dbPath: daemon.dbPath, sawLine: daemon.stdout().includes('plurnk-service acp=') }));",
        ].join("\n"));
        const run = spawn(process.execPath, [...CONDITION_ARGS, launcher], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        run.stdout.setEncoding("utf8"); run.stderr.setEncoding("utf8");
        run.stdout.on("data", (chunk: string) => { out += chunk; });
        run.stderr.on("data", (chunk: string) => { err += chunk; });
        const ended = await new Promise<{ code: number | null }>((accept) => run.once("exit", (code) => accept({ code })));
        assert.equal(ended.code, 0, `the launcher exited on its own once the daemon was ready (a released daemon holds no event-loop handle)\n${err}`);
        const report = JSON.parse(out) as { pid: number; url: string; dbPath: string; sawLine: boolean };
        pid = report.pid;
        assert.ok(report.sawLine, "readiness was read from the log file");
        assert.equal(report.dbPath, join(home, "private", "data", "plurnk", "plurnk.db"));
        assert.ok(alive(pid), "the daemon outlives its launcher");
        const response = await fetch(report.url);
        assert.notEqual(response.status, 503, "and still answers");
        assert.match(await readFile(logFile, "utf8"), READINESS_LINE, "the daemon's output is in the caller's log, not in a departed launcher");
        process.kill(pid, "SIGTERM");
        assert.ok(await untilGone(pid, 10_000), "SIGTERM by pid still ends it");
        pid = undefined;
    } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-admission}: a shared start that exits before readiness is owned to the end and reports the log's last words", { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-shared-exit-"));
    const logFile = join(home, "service.log");
    try {
        await assert.rejects(
            Launch.start({
                command: [process.execPath, "-e", "process.stderr.write('admission refused\\n'); process.exit(17)"],
                env: daemonEnv(home), lifetime: "shared", logFile, readyTimeoutMs: 10_000, stopGraceMs: 1_000,
            }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "exited");
                assert.equal(error.code, 17);
                assert.match(error.stdout, /admission refused/u, "both streams of a shared daemon land in the log, and the failure carries what it said");
                return true;
            },
        );
        // Without a log file of the caller's, a shared daemon writes to the service's own state directory.
        const root = join(home, "root");
        await assert.rejects(
            Launch.start({
                command: [process.execPath, "-e", "process.stderr.write('admission refused\\n'); process.exit(17)"],
                env: daemonEnv(home), stateRoot: root, lifetime: "shared", readyTimeoutMs: 10_000, stopGraceMs: 1_000,
            }),
            (error: unknown) => error instanceof LaunchError && /admission refused/u.test(error.stdout),
        );
        assert.match(await readFile(join(root, "state", "plurnk", "service.log"), "utf8"), /admission refused/u, "the default log is the service's <state dir>/service.log");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
});

describe("live-harness-composition", () => {
test("{§observability-boundary} live workspaces expose a model session's references and the management families", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-reference-composition" });
    try {
        const sessionId = await namedModelSession(workspace.daemon, workspace.workspaceId, "main");
        // A person's READ, acting for the model session ({§connection-lifecycle}).
        const read = async (target: string) => (await workspace.daemon.dispatchClientAction({
            workspaceId: workspace.workspaceId,
            actor: TEST_OWNER,
            contextSessionId: sessionId,
            statements: [readStmt(parsePath(target), { marks: [1, -1] })],
        }))[0];

        const skill = await read("skill://plurnk/SKILL.md");
        assert.equal(skill.status, 200);
        for (const reference of ["session", "sh"]) {
            const result = await read(`workspace:///_plurnk/plurnk/${reference}.md`);
            assert.equal(result.status, 200, `${reference}.md is READ-able in the session's actual generated tree`);
            assert.match(String(result.content), /\S/, `${reference}.md contains its contract`);
        }
        const plurnkDoc = await read("workspace:///_plurnk/tools/plurnk.md");
        assert.equal(plurnkDoc.status, 200, "plurnk.md is READ-able in the session's actual generated tree");
        for (const family of ["members", "skills", "mcp", "schedule"]) {
            const result = await read(`workspace:///_plurnk/tools/plurnk/${family}.json`);
            assert.equal(result.status, 200, `${family}.json is READ-able in the session's actual generated tree`);
            assert.match(String(result.content), /\S/, `${family}.json contains its contract`);
        }
        for (const family of ["skills", "mcp", "members", "schedule"]) {
            const result = Validator.assertFunctionalityListResult(
                await workspace.invokeWorkspaceAction(`workspace.${family}.list`, {}),
            );
            assert.equal(result.family, family, `${family} management belongs to the same composed session`);
        }
        assert.equal(inference.mock.callCount(), 0, "capability discovery never requires inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});

test("{§observability-boundary} specimen schedules deliver and shut down without activating operator rules", async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [makeMockResponse("````SEND [200]\nScheduled message received.\n````", 10)],
    });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const profile = parseEnv(await readFile(new URL("../../.env.test", import.meta.url), "utf8"));
    const environment = {
        PLURNK_SCHEDULE_ENABLED: profile.PLURNK_SCHEDULE_ENABLED!,
        PLURNK_SCHEDULE_fixture: JSON.stringify({ rule: "FREQ=HOURLY", target: "session://operator", prompt: "Operator work." }),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    Object.assign(process.env, environment);

    let now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const armed = new Map<number, () => void>();
    let nextTimer = 0;
    const init = ScheduleModule.init;
    t.mock.method(ScheduleModule, "init", (options = {}) => init({
        ...options,
        clock: () => now,
        timers: {
            set: (callback) => { const id = ++nextTimer; armed.set(id, callback); return id; },
            clear: (id) => { armed.delete(id as number); },
        },
    }));
    const workspace = await liveWorkspace({ name: "harness-schedule-composition" });
    try {
        const sessionId = await namedModelSession(workspace.daemon, workspace.workspaceId, "main");
        const session = (await workspace.daemon.listSessions(workspace.workspaceId)).find(({ id }) => id === sessionId)!;
        const list = async () => Validator.assertFunctionalityListResult(await workspace.invokeWorkspaceAction("workspace.schedule.list", {}));
        const mutate = async (verb: string, params: Record<string, unknown>) => Validator.assertFunctionalityMutationResult(
            await workspace.invokeWorkspaceAction(`workspace.schedule.${verb}`, params),
        );
        assert.equal((await list()).definitions.find(({ alias }) => alias === "fixture")?.state, "disabled");
        assert.equal(armed.size, 0, "operator rules remain disabled under the real-model gate profile");
        const discovered = Validator.assertFunctionalityDiscoverResult(await workspace.invokeWorkspaceAction("workspace.schedule.discover", {
            source: "FREQ=HOURLY;COUNT=1",
        }));
        assert.equal(discovered.candidates.length, 1);
        assert.match(discovered.candidates[0].summary ?? "", /now .+next/u);
        const definition = {
            ...discovered.candidates[0].definition,
            target: `session://${session.name}`,
            prompt: "Take the scheduled message.",

        };
        const completed: Array<{ loopId: number; result: OperationResult }> = [];
        const unsubscribe = workspace.daemon.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === workspace.workspaceId && method === "loop/terminated") {
                completed.push(params as { loopId: number; result: OperationResult });
            }
        });
        t.after(unsubscribe);
        assert.equal((await mutate("add", { alias: "beat", definition })).status, 201);
        assert.equal(armed.size, 1);
        now += 1000;
        const due = [...armed.values()];
        armed.clear();
        for (const callback of due) callback();
        await waitFor(() => completed, (events) => events.length === 1, { timeoutMs: 15_000 });
        assert.equal(completed[0].result.status, 200);
        assert.equal(await lastReply(workspace.db, completed[0].loopId), "Scheduled message received.");
        assert.equal(inference.mock.callCount(), 1, "only the explicitly added fixture scheduled inference");
        const rows = await workspace.db.test_log_entries_by_loop.all<{ op: string; origin: string; source: string | null }>({ loop_id: completed[0].loopId });
        assert.equal(rows.filter(({ op, origin, source }) => op === "SEND" && origin === "_plurnk" && source === "schedule://beat").length, 1,
            "the occurrence arrives through ordinary source-attributed session messaging");
        await waitForDb(list, ({ definitions }) => {
            const detail = definitions.find(({ alias }) => alias === "beat")?.detail;
            return isRecord(detail) && detail.exhausted === true;
        });
        assert.equal(armed.size, 0, "the one-shot rule is exhausted");
        assert.equal((await list()).definitions.find(({ alias }) => alias === "fixture")?.state, "disabled");
        assert.equal((await mutate("remove", { alias: "beat" })).status, 200);
        assert.ok(!(await list()).definitions.some(({ alias }) => alias === "beat"));
        assert.equal((await mutate("add", { alias: "later", definition: { ...definition, rule: "FREQ=HOURLY;COUNT=2" } })).status, 201);
        assert.equal(armed.size, 1, "shutdown has an armed rule to dispose");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
    assert.equal(armed.size, 0, "liveWorkspace cleanup closes the actual scheduling module");
});
});

describe("loop-resources", () => {
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

test("{§session-scheme}: exact outcomes compose with READ, FIND, COPY and immutable source boundaries", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "loop-resources");
    const sessionId = await insertSession(db, workspaceId, null, "reader");
    const loopId = await insertLoop(db, sessionId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model" });
    const child = await insertSession(db, workspaceId, null, "child");
    const first = await insertLoop(db, child, 1);
    const source = parsePath("ops://child/1")!;
    const unfinished = await dispatch(readStmt(source));
    assert.equal(unfinished.status, 425);
    assert.equal(unfinished.resource, source.raw);
    assert.equal(unfinished.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");
    const body = Array.from({ length: 30 }, (_, i) => `Result line ${i + 1}`).join("\n");
    const lifecycle = new LoopLifecycle(db);
    await lifecycle.finish(first, { status: 200, content: body, mimetype: "text/plain" });
    const whole = await dispatch(readStmt(source));
    assert.equal(whole.status, 200);
    assert.equal(whole.content, body, "a markerless READ of a result is its first page; 30 lines fit it ({§packet})");
    assert.equal(whole.lineAnchors, undefined);
    assert.deepEqual(whole.range, { unit: "line", total: 30, requested: [1, PAGE], returned: [1, 30] });
    assert.equal((await dispatch(readStmt(source, { marks: [17, -1] }))).content, body.split("\n").slice(16).join("\n"));

    const live = await insertLoop(db, child, 2);
    const latest = await dispatch(readStmt(parsePath("session://child")));
    assert.equal(latest.status, 425);
    assert.equal(latest.resource, "ops://child/2");
    assert.equal((await dispatch(readStmt(source, { marks: [1, -1] }))).content, body);
    for (const target of ["ops://child/*", "ops://*/1", "ops://child/1"]) {
        const found = await dispatch(findStmt(parsePath(target)));
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.match(JSON.stringify(found.results), /ops:\/\/child\/1/);
    }
    const destination = parsePath("workspace:///copied.txt")!;
    assert.equal((await dispatch(copyStmt(source, destination, { marks: [20, 21] }))).status, 201);
    assert.equal((await dispatch(readStmt(destination))).content, "Result line 20\nResult line 21\n");
    for (const statement of [editStmt(source, "changed"), killStmt(source), moveStmt(source, parsePath("workspace:///moved.txt")!), copyStmt(destination, source)]) {
        const denied = await dispatch(statement);
        assert.equal(denied.status, 403, JSON.stringify(denied));
        assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
        assert.equal((await lifecycle.result(first))?.content, body, "no mutation changes the outcome");
    }
    assert.equal((await dispatch(readStmt(parsePath("ops://child/99")))).status, 404);
    for (const target of ["ops:///1", "ops://child/0", "ops://child/1?latest=1", "ops://child/9007199254740992"]) {
        const invalid = await dispatch(readStmt(parsePath(target)));
        assert.equal(invalid.status, 400, target);
        assert.equal(invalid.problem?.type, "https://problems.plurnk.xyz/scheme/ops/coordinate-malformed");
    }
    const otherWorkspace = await insertWorkspace(db, "separate-loop-resources");
    const otherChild = await insertSession(db, otherWorkspace, null, "child");
    const otherLoop = await insertLoop(db, otherChild, 1);
    await lifecycle.finish(otherLoop, { status: 200, content: "Different workspace." });
    assert.equal((await dispatch(readStmt(source, { marks: [1, -1] }))).content, body, "workspace scope is not session privacy");
    await lifecycle.finish(live, { status: 200 });
    const collected = await dispatch(readStmt(parsePath("session://child")));
    assert.equal(collected.status, 200);
    assert.equal(collected.content, "");
    assert.equal(collected.resource, "ops://child/2");

    const third = await insertLoop(db, child, 3);
    const exact = Results.failure("test:source", "failed", 502, "Provider failed.");
    await lifecycle.finish(third, exact);
    const fourth = await insertLoop(db, child, 4);
    const external = Results.failure("test:source", "external", 502, "Remote request failed.");
    Results.attachInstance(external, "https://example.test/errors/abc123");
    await lifecycle.finish(fourth, external);
    await Fork.fork(db, child, "branch");
    const inherited = await dispatch(readStmt(parsePath("ops://branch/3")));
    assert.equal(inherited.status, 502);
    assert.equal(inherited.problem?.instance, "ops://branch/3");
    assert.equal(inherited.content, "Provider failed.");
    assert.equal((await dispatch(readStmt(parsePath("ops://branch/1"), { marks: [1, -1] }))).content, body);
    assert.equal((await dispatch(readStmt(parsePath("ops://branch/4")))).problem?.instance, external.problem?.instance);
});

test("{§session-scheme}: source identity and exact outcome survive reopening the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-loop-resource-"));
    let db = await openMigrated(join(directory, "plurnk.db"));
    try {
        const workspaceId = await insertWorkspace(db, "loop-resource-restart");
        const sessionId = await insertSession(db, workspaceId, null, "producer");
        const loopId = await insertLoop(db, sessionId, 1);
        const exact = await new LoopLifecycle(db).finish(loopId, Results.failure("test:source", "failed", 502, "Retained failure."));
        assert.ok(exact);
        await db.close();
        db = await openMigrated(join(directory, "plurnk.db"));
        const reader = await insertSession(db, workspaceId, null, "reader");
        const readingLoop = await insertLoop(db, reader, 1);
        const turnId = await insertTurn(db, readingLoop, 1);
        const read = await new Engine({ db, schemes: new SchemeRegistry() }).dispatch({
            workspaceId, sessionId: reader, loopId: readingLoop, turnId, sequence: 1, origin: "model",
            statement: readStmt(parsePath("ops://producer/1")),
        });
        assert.equal(read.status, 502);
        assert.equal(read.resource, "ops://producer/1");
        assert.equal(read.content, "Retained failure.");
        assert.deepEqual(read.problem, exact.problem);
    } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
    }
});
});

describe("module-client-boot", () => {
// {§credential-authority} — the composed boot: a consumer module registers its confidential
// client at setup knowing no origin, set up before the client interface or after it, and is answered
// at its path on the issuer, under the address its request reached on an ephemeral port and under a
// configured public one.








const CALLBACK = "/consumer/callback";
const STYLESHEET = "/consumer/authority.css";

// A module of this daemon as a consumer writes one: it claims a mount, registers its client at setup
// with the path alone, reads the face at start, and serves its callback on its own mount.
const consumer = () => {
    const seen = { secret: "", facePublishedAtSetup: false, issuerAtStart: "", codes: [] as string[] };
    const module = {
        mounts: ["/consumer"],
        setup: (seam: Pick<ApplicationPort, "credentials">): void => {
            seen.facePublishedAtSetup = seam.credentials.face() !== null;
            seen.secret = seam.credentials.registerClient({ id: "consumer", redirectPaths: [CALLBACK], scopes: ["acp"], stylesheetPath: STYLESHEET }).clientSecret;
        },
        start: (port: ApplicationPort): void => {
            seen.issuerAtStart = port.credentials.face()!.issuer();
            port.registerHttpRoute("/consumer", (req, res) => {
                const url = new URL(req.url ?? "/", "http://consumer");
                if (url.pathname === CALLBACK) seen.codes.push(url.searchParams.get("code") ?? "");
                res.writeHead(url.pathname === CALLBACK ? 200 : 404);
                res.end();
            });
        },
    };
    return { module, seen };
};

for (const order of ["the consumer set up first", "the client interface set up first"] as const) {
    for (const issuer of ["", "https://plurnk.example"] as const) {
        const origin = issuer === "" ? "the address the request reached, on an ephemeral port" : "a configured issuer";
        test(`{§credential-authority} ${order}, ${origin}: a module registers at setup and is answered at its path on the issuer`, async (t) => {
            const db = await openMigrated();
            const http = await bindListener();
            const daemon = new Daemon({ db, provider: null, http });
            t.after(async () => {
                await daemon.stop();
                await http.close();
                await db.close();
            });
            const { module, seen } = consumer();
            const auth = AuthModule.create({ auth: true, issuer, password: "composed" });
            if (order === "the consumer set up first") {
                daemon.registerModule(module, "@acme/consumer");
                daemon.registerModule(auth, "@plurnk/plurnk-auth");
            } else {
                daemon.registerModule(auth, "@plurnk/plurnk-auth");
                daemon.registerModule(module, "@acme/consumer");
            }
            await daemon.start();

            const base = `http://127.0.0.1:${http.httpAddress().port}`;
            const expected = issuer === "" ? base : issuer;
            assert.equal(seen.facePublishedAtSetup, order === "the client interface set up first", "registration waited on no other module");
            assert.equal(seen.issuerAtStart, expected, "{§credential-authority}: the face answers its issuer in a module's start");

            const redirect = `${expected}${CALLBACK}`;
            const verifier = randomBytes(32).toString("base64url");
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: "consumer", redirect_uri: redirect, response_type: "code", scope: "acp", code_challenge: challenge, code_challenge_method: "S256" })}`);
            assert.ok((await page.text()).includes(`<link rel="stylesheet" href="${STYLESHEET}">`), "{§auth-oauth-clients}: the module's own stylesheet on the page it is signed in at");
            // The operator signs in at the authorization endpoint, which answers the consumer's client at once.
            const authorized = await fetch(`${base}/oauth/authorize`, {
                method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: "consumer", redirect_uri: redirect, response_type: "code", scope: "acp", state: "s",
                    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
                    password: "composed",
                }).toString(),
            });
            assert.equal(authorized.status, 302, await authorized.text());
            const location = new URL(authorized.headers.get("location")!);
            assert.equal(`${location.origin}${location.pathname}`, redirect, "answered at the module's path on the issuer");
            const code = location.searchParams.get("code")!;

            // The browser follows the redirect; whatever fronts a configured issuer forwards the path here.
            assert.equal((await fetch(`${base}${location.pathname}${location.search}`)).status, 200);
            assert.deepEqual(seen.codes, [code], "the module's own mount received the code");

            const exchanged = await fetch(`${base}/oauth/token`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`consumer:${seen.secret}`).toString("base64")}` },
                body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }).toString(),
            });
            const body = await exchanged.text();
            assert.equal(exchanged.status, 200, body);
            const claims = daemon.credentials.verify((JSON.parse(body) as { access_token: string }).access_token);
            assert.deepEqual([claims?.kind, claims?.clientId, claims?.scopes], ["access", "consumer", ["acp"]]);
        });
    }
}
});

describe("observe-exporter-failure", () => {
// Exporter failure isolation ({§observability-boundary}): an exporter that
// rejects every export must not change product results, lifecycle, or the
// client-visible outcome. The same loop terminates 200 with or without it.









class ExplodingExporter implements SpanExporter {
    export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        resultCallback({ code: ExportResultCode.FAILED, error: new Error("exporter exploded") });
    }
    shutdown(): Promise<void> { return Promise.resolve(); }
    forceFlush?(): Promise<void> { return Promise.resolve(); }
}

test("{§observability-boundary} observe: an exploding exporter cannot change the loop result or daemon lifecycle", async () => {
    assert.equal(await explosionProofLoop(), true);
});

// Register the failing exporter for this process and run exactly one real loop;
// the daemon/lifecycle assertions run while the exporter is live.
const explosionProofLoop = async (): Promise<boolean> => {
    trace.disable();
    context.disable();
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const provider = new TracerProvider({
        spanProcessors: [new SimpleSpanProcessor({ exporter: new ExplodingExporter() })],
    });
    trace.setGlobalTracerProvider(provider);
    let finalStatus: number | undefined;
    try {
        const mock = new Mock({
            contextWindow: 16384,
            responses: [{
                assistant: {
                    content: "\n````SEND [200]\nstill works.\n````",
                    reasoning: null,
                },
            }],
        });
        await withDaemon(mock, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "exploder", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: "Prove exporter failure cannot change the product.",
            }, { timeoutMs: 60_000 });
            finalStatus = term.finalStatus;
            return Promise.resolve();
        });
    } finally {
        await provider.shutdown();
        contextManager.disable();
        trace.disable();
        context.disable();
    }
    return finalStatus === 200;
};
});

describe("observe-genai", () => {
test("{§observability-boundary} normal and BARE calls export provider identity, accounting, and redacted failures", async () => {
    const expectedProviders = ["openai", "anthropic", "deepseek", "gcp.gemini", "aws.bedrock", "moonshot_ai", "moonshot_ai", "x_ai", "mistral_ai", "custom-endpoint", "other"];
    const samples = await recordGenAiSpans();
    assert.equal(samples.length, expectedProviders.length);
    for (const [index, { providerId, result, spans }] of samples.entries()) {
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ status }) => status), [200, 502], `${providerId}: one BARE succeeds and the exhausted BARE provider fails`);
        assert.equal(spans.length, 3, `${providerId}: one main call and two BARE calls`);
        for (const span of spans) {
            assert.equal(span.kind, SpanKind.CLIENT);
            assert.equal(span.name, "chat mock");
            assert.equal(span.attributes["gen_ai.request.model"], "mock");
            assert.equal(span.attributes["gen_ai.provider.name"], expectedProviders[index]);
            assert.equal(span.attributes["gen_ai.system"], undefined);
            assert.equal(span.attributes.attempt, 1);
            assert.equal(span.events.length, 0);
            assert.doesNotMatch(JSON.stringify(span.attributes), /private-|private /);
        }
        const main = spans.find((span) => span.attributes.kind !== "bare");
        assert.ok(main);
        assert.equal(main.attributes["gen_ai.usage.input_tokens"], 12);
        assert.equal(main.attributes["gen_ai.usage.output_tokens"], 8);
        const bare = spans.filter((span) => span.attributes.kind === "bare");
        const success = bare.find((span) => span.status.code === SpanStatusCode.UNSET);
        assert.ok(success);
        assert.equal(success.attributes["gen_ai.usage.input_tokens"], 5);
        assert.equal(success.attributes["gen_ai.usage.output_tokens"], 3);
        assert.deepEqual(success.attributes["gen_ai.response.finish_reasons"], ["stop"]);
        const failure = bare.find((span) => span.status.code === SpanStatusCode.ERROR);
        assert.ok(failure);
        assert.equal(failure.attributes["error.type"], "ProviderError");
        assert.equal(failure.attributes["gen_ai.usage.input_tokens"], undefined);
        assert.equal(failure.attributes["gen_ai.response.finish_reasons"], undefined);
        assert.equal(failure.status.message, undefined, "provider error text stays outside telemetry");
    }
});
});

describe("observe-redaction", () => {
// Redaction-by-default at the observational boundary ({§observability-boundary}):
// a loop whose prompt and workspace carry recognizable content — a secret
// sentinel, a fixture fact, a hostname, and a .example URL — must never leak any
// of it into exported span names, attributes, or events.






const SECRET = "secret-xyzzy-9371";
const FACT = "phoenix-briefing";
const HOST = "db.internal";
const URL = "https://leak.example/path";

const settleExports = (): Promise<void> => new Promise((done) => setTimeout(done, 10));

const serialized = (spans: ReturnType<{ spans(): unknown[] }["spans"]>): string => {
    const parts: string[] = [];
    for (const span of spans as Array<Record<string, unknown>>) {
        parts.push(String(span.name));
        for (const [key, value] of Object.entries((span.attributes ?? {}) as Record<string, unknown>)) {
            parts.push(`${key}=${String(value)}`);
        }
        for (const event of (span.events ?? []) as Array<{ name: string; attributes?: Record<string, unknown> }>) {
            parts.push(`event:${event.name}`);
            for (const [key, value] of Object.entries(event.attributes ?? {})) parts.push(`${key}=${String(value)}`);
        }
    }
    return parts.join("\n");
};

test("{§observability-boundary} observe: prompts, bodies, hosts, URLs, and secrets never cross the boundary", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const memory = await mountMemoryTracing();
    try {
        const provider = new Mock({
            contextWindow: 16384,
            responses: [{
                assistant: {
                    content: "\n````SEND [200]\ntask complete.\n````",
                    reasoning: null,
                },
            }],
        });
        await withDaemon(provider, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "redaction-probe", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: `The codename is ${FACT}, the host is ${HOST}, and the vault secret is ${SECRET}. Read ${URL} to confirm.`,

            }, { timeoutMs: 60_000 });
            assert.equal(term.finalStatus, 200);
        });
        await settleExports();

        const text = serialized(memory.spans());
        for (const forbidden of [SECRET, FACT, HOST, URL, "leak.example", "secret-"] as const) {
            assert.ok(!text.includes(forbidden), `span surface must not contain ${JSON.stringify(forbidden)}`);
        }
        assert.ok(text.includes("loop.run"), "the boundary still exports its topology names");
    } finally {
        await memory.shutdown();
    }
});
});

describe("observe-retry", () => {
// Retried child failures must not falsely fail the parent
// ({§observability-boundary}): the engine retries an invalid emission under
// the same turn; the failed first attempt and the successful second both
// appear as separate inference spans, and the turn and loop end OK.







const settleExports = (): Promise<void> => new Promise((done) => setTimeout(done, 10));

test("{§observability-boundary} observe: an invalid first emission retries under the turn without failing the successful parent", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const memory = await mountMemoryTracing();
    try {
        const provider = new Mock({
            contextWindow: 16384,
            responses: [
                {
                    assistant: {
                        // No executable operation or lifecycle declaration.
                        content: "````READ (workspace:///not-a-plurnk-turn",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "\n````SEND [200]\nrecovered.\n````",
                        reasoning: null,
                    },
                },
            ],
        });
        await withDaemon(provider, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "observe-retry", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: "Recover from a bad emission.",

            }, { timeoutMs: 60_000 });
            assert.equal(term.finalStatus, 200);
        });
        await settleExports();

        const spans = memory.spans();
        const generates = spans.filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
        assert.equal(generates.length, 2, "the invalid attempt and the retry are separate provider spans");
        const attempts = generates.map((s) => Number(s.attributes.attempt)).toSorted((a, b) => a - b);
        assert.deepEqual(attempts, [1, 2]);
        assert.ok(generates.every((span) => span.name === `chat ${String(span.attributes["gen_ai.request.model"])}`));

        const turn = spans.find((s) => s.name === "loop.turn");
        assert.ok(turn !== undefined);
        assert.equal(turn.status.code, 0, "the turn span stays OK after the retried child failure");
        const loop = spans.find((s) => s.name === "loop.run");
        assert.ok(loop !== undefined);
        assert.equal(loop.status.code, 0, "the loop span stays OK");
        assert.equal(loop.attributes.status, 200, "the loop records its terminal 200");

        const childOf = (parent: ReadableSpan, name: string): ReadableSpan[] =>
            spans.filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId && s.name === name);
        assert.equal(childOf(turn, generates[0].name).length, 2, "both attempts nest under the turn");
        assert.ok(
            generates.every((g) => g.parentSpanContext !== undefined),
            "provider spans are never roots",
        );
    } finally {
        await memory.shutdown();
    }
});
});

describe("observe-topology", () => {
// The observational boundary's span topology through the REAL loop path
// ({§observability-boundary}). A Mock provider without pre-supplied ops drives
// the production parse path. One warmed engine cycle may complete the ordinary
// initialization turn before its inference turn; provider and parse belong to
// the inference result identified on the cycle span.








const settleExports = (): Promise<void> => new Promise((done) => setTimeout(done, 10));

test("{§observability-boundary} observe: a real loop emits the loop → turn → provider → parse → dispatch topology", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The surveys are the initialization program; with the preview off there is none to dispatch.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const memory = await mountMemoryTracing();
        try {
            const provider = new Mock({
                contextWindow: 16384,
                responses: [{
                    assistant: {
                        // ops deliberately absent: the engine must parse this content.
                        content: "\n````SEND [200]\nobserved.\n````",
                        reasoning: null,
                    },
                }],
            });
            await withDaemon(provider, async (db, daemon) => {
                const ws = await connect({ daemon });
                const created = (await rpcCall(ws, 1, "workspace.create", {
                    name: "observe-topology", projectRoot: null,
                })).result as { id: number };
                assert.ok(Number.isInteger(created.id));
                const term = await runLoopToTerminal(ws, 2, {
                    prompt: "Explain the loop topology.",

                }, { timeoutMs: 60_000 });
                assert.equal(term.finalStatus, 200);
            });
            await settleExports();

            const spans = memory.spans();
            const childrenByParent = new Map<string | undefined, ReadableSpan[]>();
            for (const s of spans) {
                const parent = s.parentSpanContext?.spanId;
                const list = childrenByParent.get(parent) ?? [];
                list.push(s);
                childrenByParent.set(parent, list);
            }

            const loop = spans.find((s) => s.name === "loop.run");
            assert.ok(loop !== undefined, `loop.run span exists; got names: ${spans.map((s) => s.name).join(", ")}`);
            assert.ok(Number.isInteger(loop.attributes["loop.id"]), "loop.run carries the loop id");
            assert.ok(Number.isInteger(loop.attributes["status"]), "loop.run records its terminal status");

            const turns = (childrenByParent.get(loop.spanContext().spanId) ?? []).filter((s) => s.name === "loop.turn");
            assert.equal(turns.length, 1, "one loop iteration retains one warmed engine-cycle span");
            const turn = turns[0];
            assert.equal(turn.attributes["turn.producer"], "model");
            assert.equal(turn.attributes["turn.kind"], "inference");
            assert.ok(Number.isInteger(turn.attributes["loop.id"]));
            assert.ok(Number.isInteger(turn.attributes["turn.id"]));

            const turnChildren = childrenByParent.get(turn.spanContext().spanId) ?? [];
            const generate = turnChildren.find((s) => s.attributes["gen_ai.operation.name"] === "chat");
            assert.ok(generate !== undefined, "the turn nests the provider call");
            assert.equal(generate.kind, SpanKind.CLIENT, "the GenAI convention span is CLIENT-kind");
            assert.equal(generate.attributes["gen_ai.operation.name"], "chat");
            assert.equal(generate.attributes["gen_ai.provider.name"], "openai", "provider identity comes from the registered route, not its mocktest alias");
            assert.equal(generate.attributes["gen_ai.system"], undefined);
            assert.ok(typeof generate.attributes.model === "string" && generate.attributes.model.length > 0);
            assert.equal(generate.attributes["gen_ai.request.model"], generate.attributes.model);
            assert.equal(generate.name, `chat ${generate.attributes.model}`);
            assert.ok(Number.isInteger(generate.attributes.attempt), "the provider span carries the emission attempt");
            assert.deepEqual(
                generate.attributes["gen_ai.response.finish_reasons"],
                ["stop"],
                "the settled span carries the convention finish reason",
            );

            // The parse is synchronous and ends before model dispatch.
            const parse = turnChildren.find((s) => s.name === "contracts.parse");
            assert.ok(parse !== undefined, "the turn nests the parse because the mock supplied no ops");
            assert.equal(parse.attributes.statements, 1, "parse records the emitted SEND");

            const dispatches = turnChildren.filter((s) => s.name === "op.dispatch");
            const ops = dispatches.map((s) => s.attributes.op);
            assert.equal(ops.filter((op) => typeof op === "string" && TurnDisposition.isOp(op)).length, 0, "completion invents no lifecycle operation");
            assert.ok(ops.includes("FIND"), "initialization's surveys use ordinary dispatch");
            assert.equal(ops.filter((op) => op === "SEND").length, 1, "the model's completion has its own dispatch span");
            assert.ok(
                ops.filter((op) => op !== "SEND" && (typeof op !== "string" || !TurnDisposition.isOp(op))).every((op) => op === "NOTE" || op === "FIND" || op === "READ"),
                `initialization dispatches only reasoning operations; got ${ops.join(", ")}`,
            );
            for (const d of dispatches) {
                assert.ok(Number.isInteger(d.attributes.status), "every dispatched op records its result status");
            }
        } finally {
            await memory.shutdown();
        }
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});
});

describe("service-stop", () => {
// {§startup-admission} {§startup-admission} — `plurnk-service stop` against a real shared daemon on a private state root.








const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));

// Everything the daemon or the command could write lands under `home`; the operator's own service is never named.
const serviceEnv = (home: string, root: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        PLURNK_SERVICE_STATE_ROOT: root,
    };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_DB_PATH;
    return env;
};

const stop = (env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> => new Promise((accept) => {
    const run = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "stop"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    run.stderr.setEncoding("utf8");
    run.stderr.on("data", (chunk: string) => { stderr += chunk; });
    run.once("exit", (code) => accept({ code, stderr }));
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("{§startup-admission}: stop ends the service holding the configured database and returns once it has exited; a second stop finds nothing running", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-service-stop-"));
    const root = join(home, "root");
    const env = serviceEnv(home, root);
    let pid: number | undefined;
    try {
        const daemon = await Launch.start({
            command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"], env, lifetime: "shared",
            host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000,
        });
        pid = daemon.child.pid;
        assert.ok(pid !== undefined && alive(pid), "the shared daemon runs");
        assert.equal(daemon.logFile, join(root, "state", "plurnk", "service.log"));
        assert.match(await readFile(daemon.logFile, "utf8"), READINESS_LINE, "a shared daemon writes to the service's own log");

        const stopped = await stop(env);
        assert.equal(stopped.code, 0, stopped.stderr);
        assert.match(stopped.stderr, new RegExp(`stopped pid ${pid} \\(`, "u"));
        assert.equal(alive(pid), false, "stop returns only after the process has exited");
        await assert.rejects(access(`${daemon.dbPath}.lock`), "its lock is released");
        pid = undefined;

        const again = await stop(env);
        assert.equal(again.code, 0, "a database nobody holds is not an error");
        assert.match(again.stderr, /not running \(/u);
    } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        await rm(home, { recursive: true, force: true });
    }
});
});
