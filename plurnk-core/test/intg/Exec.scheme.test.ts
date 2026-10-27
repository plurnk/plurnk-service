import test, { describe, before as beforeAll, after as afterAll, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ExecutorRegistry, { type RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import ExecScratch from "../../src/schemes/ExecScratch.ts";
import SessionName, { SessionNameError } from "../../src/core/SessionName.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import Envelope from "../../src/server/envelope.ts";
import ExecutionOutputs from "../../src/core/ExecutionOutputs.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EnvFunctionality from "../../src/server/EnvFunctionality.ts";
import { ownSession, serverProposals, TEST_OWNER } from "./_approval.ts";
import { type ExecStatement, type RuntimeTag, isExecution, type UrlPath, type ReadStatement, type KillStatement, Validator, type FunctionalityListResult, type CapabilityPolicy } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { testExecutors, executionAddress, awaitExecOutcome } from "./_execs.ts";
import { makeSchemeCtx, schemeManifest, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { type Executor, BaseExecutor, type Effect, type ExecArgs, type ExecInput, type RuntimeInvocationDecl, type ExecResult } from "@plurnk/plurnk-execs";
import { type SchemeManifest } from "../../src/core/types.ts";
import { localPath, readStmt, urlPath, execStmt as dslExecStmt, completeStmt, dispositionStmt, noteStmt } from "./_dsl.ts";
import { mkdtemp, writeFile, mkdir, readFile, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve as resolvePath } from "node:path";
import { InvalidOperationResultError, type RepresentationPreparationRequest, type SchemeCtx, type SchemeHandler, OutputScheme, type EntryReadResult, type RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { type WakeSessionPayload } from "../../src/core/ChannelWrite.ts";
import { waitForDb, rpcCall, subscribeNotifications, connect, withDaemon, runLoopToTerminal, waitFor } from "./_rpc.ts";
import { clientRead } from "./_client-read.ts";
import { setTimeout as delay } from "node:timers/promises";
import { viableWindow } from "./_provider.ts";
import { makeRawMockResponse, makeMockResponse, fixtureExecutors } from "./_mock.ts";
import { namedModelSession, modelOperation } from "./_sessions.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { MCP_CONTROLS, mcpFixture, stdioEntry, httpEntry, mcpEnvironment } from "./_mcp-config.ts";
import { fileURLToPath } from "node:url";
import { McpServer, createMcpHandler, fromJsonSchema, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";

describe("Exec.scheme", () => {
// Exec scheme — the execution op handler per plurnk.md.
//   ### EXEC_ [runtime] (target)\nbody
// Auto-generates a `<runtime>:///<loop>/<turn>/<seq>` entry (the runtime tag IS the
// authority); spawns the subprocess; streams stdout/stderr into channels; closes
// subscription + transitions channel state at exit.



















// {§exec-executor-slot} — a null runtime is the bare shell; the target is the program or working directory.
const execStmt = (runtime: string | null, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null,
    target: target === null ? null : localPath(target),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const withWorkspace = async <T>(fn: (ctx: {
    engine: Engine;
    exec: Exec;
    db: Awaited<ReturnType<typeof openMigrated>>;
    workspaceId: number; sessionId: number; loopId: number; turnId: number;
}) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors);
        const workspaceId = await insertWorkspace(db, `exec-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "exec test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn({ engine, exec, db, workspaceId, sessionId, loopId, turnId });
    } finally {
        await db.close();
    }
};

test("{§exec-executor-slot} execution: empty body and absent target → 400", async () => {
    await withWorkspace(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt(null, null, ""),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    });
});

test("{§exec-executor-slot} Exec.applyResolution: malformed accepted proposal state remains an internal invariant", async () => {
    await withWorkspace(async (ctx) => {
        await assert.rejects(
            ctx.exec.applyResolution(
                { attrs: {}, metadata: null },
                makeSchemeCtx({
                    db: ctx.db,
                    workspaceId: ctx.workspaceId,
                    sessionId: ctx.sessionId,
                    loopId: ctx.loopId,
                    turnId: ctx.turnId,
                    executors: await testExecutors(),
                }),
            ),
            InvalidOperationResultError,
        );
    });
});

test("{§exec-target-routing} an empty-body scheme target is materialized as the targeted script", async () => {
    await withWorkspace(async (ctx) => {
        // A stored script lives at workspace:///script; running it runs its content.
        await seedEntryWithChannel(ctx.db, { workspaceId: ctx.workspaceId, scheme: "workspace", pathname: "/script", channel: "body", content: "echo resolved-from-scheme", state: "static" });

        const statement: ExecStatement = {
            metadata: null,
            runtime: "sh", aside: null,
            target: urlPath("workspace", "/script"),
            lineMarker: null, body: "", position: { line: 1, column: 1 },
        };

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "empty body + scheme target is accepted, not 400");
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
        assert.ok(entryRow, "sh entry exists");
        const stdout = await ctx.db.test_get_channel.get<{ content: string }>({ entry_id: entryRow.id, name: "stdout" });
        assert.equal(stdout?.content, "resolved-from-scheme\n", "the stored script becomes the executor target and runs");
    });
});

test("{§execution-output-identity} missing output resources report their exact address without inferring session ownership", async () => {
    // The runtime schemes must be registered for a READ on `sh:///…` to reach the stream face.
    const executors = await testExecutors();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, `stream-404-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "stream 404");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (statement: ReturnType<typeof readStmt>, sequence: number) => engine.dispatch({
            statement, workspaceId, sessionId, loopId, turnId, sequence, origin: "model",
        });
        const own = await dispatch(readStmt(urlPath("sh", "/9/9/9/sh")), 1);
        assert.equal(own.status, 404);
        const ownText = JSON.stringify(own);
        assert.match(ownText, /entry-not-found/);
        assert.match(ownText, /No entry exists at sh:\/\/\/9\/9\/9\/sh/u, "READ reports the actual missing resource");
        const foreign = await dispatch(readStmt({ ...urlPath("sh", "/1/1/1/sh"), hostname: "nobody", raw: "sh://nobody/1/1/1" }), 2);
        assert.equal(foreign.status, 404);
        const foreignText = JSON.stringify(foreign);
        assert.match(foreignText, /entry-not-found/);
        assert.match(foreignText, /sh:\/\/\/nobody\/1\/1\/1\/sh/, "the miss names the normalized resource");
        assert.doesNotMatch(foreignText, /nobody does not exist|no such session/, "no existence leak for a foreign authority");
    } finally { await db.close(); }
});

test("{§exec-target-routing} {§diagnostic-observation} a bare target that is another runtime's registered tool is refused naming that runtime (#388)", async () => {
    const real = await testExecutors();
    const sh = real.entry("sh");
    assert.ok(sh, "the real shell entry exists");
    const executor: Executor = {
        runtime: "crm",
        glyph: "?",
        get manifest(): SchemeManifest { return { ...schemeManifest("crm", { results: "text/plain" }, "results"), volatile: true }; },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
        async run() { return { status: 200 }; },
            async probe() { return { available: true }; },
            effect() { return "pure"; },
            toolRegistry() {
                return { tools: [{
                    target: "crm_query",
                    summary: "Query the fixture CRM.",
                    invocation: {
                        body: { role: "JSON arguments", required: true },
                        target: { role: "registered tool", required: true, kind: "literal" as const },
                        signature: '{"soql": string}',
                    },
                }] };
            },
    };
    const registrytool: RegistryEntry = {
        executor,
        namespaceOwner: { kind: "module", name: "crm fixture" },
        glyph: "?",
        summary: "crm fixture.",
        invocation: { body: { role: "JSON arguments", required: false }, target: { role: "registered tool", required: true, kind: "literal" }, example: { target: "crm_query" } },
        details: "",
        available: true,
        detail: undefined,
    };
    assert.ok(sh.available, "the shell fixture is available");
    const executors = new ExecutorRegistry(new Map<string, RegistryEntry>([["sh", sh], ["crm", registrytool]]));
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, `exec-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "owner hint");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: execStmt(null, "crm_query", "{\"soql\": \"SELECT Id FROM Case\"}"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "still refused before any spawn");
        const rendered = JSON.stringify(result);
        assert.match(rendered, /target-not-found/);
        assert.match(rendered, /The tool `crm_query` is registered under executor `crm`\."/, "the recovery says where the tool is registered, and builds no fence");
        assert.match(rendered, /"toolRuntimes":\["crm"\]/);
    } finally { await db.close(); }
});

test("{§exec-target-routing} a target that is neither a directory nor a script is refused before anything spawns, without naming the host directory", async () => {
    await withWorkspace(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt(null, "curl", "curl -sS -X POST http://localhost:8000/submit"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "refused, never spawned as `sh curl`");
        const rendered = JSON.stringify(result);
        assert.match(rendered, /target-not-found/);
        assert.match(rendered, /The sh program does not resolve as a script or a registered tool for this executor\./);
        assert.doesNotMatch((result.problem as { detail?: string } | undefined)?.detail ?? "", /curl|under /, "the target and cwd remain structured facts");
        assert.match(rendered, /"recovery":"The target must name an existing program resource\."/, "the other reading of the fence is not offered");
        assert.ok(!rendered.includes(process.cwd()), "{§fs-namespace} the refusal never names the host directory it searched");
    });
});

test("{§exec-target-routing} {§diagnostic-observation} a target that names another available executor is refused saying so, with no fence built (#895)", async () => {
    await withWorkspace(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt(null, "python3", "import json\nprint(json.dumps({\"ok\": True}))"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "refused, never spawned as `sh python3`");
        const rendered = JSON.stringify(result);
        assert.match(rendered, /target-not-found/);
        assert.match(rendered, /"recovery":"`python3` is its own executor\."/, "the recovery states what python3 is");
    });
});

test("{§exec-target-routing} `(.)` in a headless workspace is the shell's own cwd, and the receipt names it", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt(null, ".", "pwd"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        await ctx.exec.idle();
        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname, cwd } = JSON.parse(log?.attrs ?? "{}") as { pathname: string; cwd: string };
        assert.equal(cwd, process.cwd(), "the receipt names the working directory");
        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
        const stdout = await ctx.db.test_get_channel.get<{ content: string }>({ entry_id: entryRow!.id, name: "stdout" });
        assert.equal(stdout?.content, `${process.cwd()}\n`);
    });
});
test("{§exec-executor-slot} bare execution defaults to sh and proposes with {runtime, cwd, body, pathname}", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt(null, null, "echo hello"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { runtime: string; cwd: string | null; body: string; pathname: string };
        assert.equal(attrs.runtime, "sh");
        assert.equal(attrs.cwd, process.cwd(), "a headless workspace runs in the shell's own cwd, and says so");
        assert.equal(attrs.body, "echo hello");
        assert.match(attrs.pathname, /^\/[a-f0-9]{8}$/, "a workspace-stable address does not encode its log coordinate");

        ctx.engine.resolveProposal(logEntryId, { decision: "reject" });
        await dispatchPromise;
    });
});

test("{§exec-target-routing} the target slot remains distinct from cwd", async () => {
    await withWorkspace(async (ctx) => {
        const executor: Executor = {
            runtime: "filter",
            glyph: "?",
            get manifest(): SchemeManifest { return { ...schemeManifest("filter", { results: "application/json" }, "results"), volatile: true }; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "application/json" } }; },
            async run({ setState }) { setState("results", "closed"); return { status: 200 }; },
            async probe() { return { available: true }; },
            effect() { return "read"; },
        };
        ctx.engine.registerRuntime("filter", {
            executor,
            namespaceOwner: { kind: "module", name: "filter fixture" },
            glyph: "?",
            summary: "filter fixture.",
            invocation: {
                body: { role: "filter expression", required: true },
                target: { role: "data resource", required: false, kind: "resource" },
                example: { body: "length" },
            },
            details: "",
            available: true,
            detail: undefined,
        });
        const idDeferred = deferred<number>();
        // The resource target supplies input data; cwd independently supplies its resolution base.
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("filter", "data/users.json", "length"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const attrs = JSON.parse(row?.attrs ?? "{}") as { runtime: string; cwd: string | null; target: string | null; body: string };
        assert.equal(attrs.target, "data/users.json", "the (target) slot is the data source, in attrs.target");
        assert.equal(attrs.cwd, process.cwd(), "cwd is the workspace, or the shell's own cwd when headless — never the target");
        assert.equal(attrs.body, "length", "the body is the filter program");
        await dispatchPromise; // read effect auto-runs inline (no proposal); let it settle
        await ctx.exec.idle();
    });
});

test("{§exec-target-routing} a file target with an empty body runs the file", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-file-"));
        try {
            await writeFile(join(root, "greet.sh"), "echo hi\n");
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idD = deferred<number>();
            const p = ctx.engine.dispatch({
                statement: execStmt(null, "greet.sh", ""),  // shell script target, empty body
                workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idD.resolve(id),
            });
            const id = await idD.promise;  // a log row minted ⇒ it dispatched (proposed), never the empty-body 400
            const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
            const attrs = JSON.parse(row?.attrs ?? "{}") as { cwd: string | null; target: string | null; body: string };
            assert.equal(attrs.target, "greet.sh", "a FILE target is the program the executor runs (body = stdin)");
            assert.equal(attrs.cwd, root, "a file target never moves cwd — it stays the workspace");
            assert.equal(attrs.body, "", "empty body is legal for a file target — run it, no stdin");
            ctx.engine.resolveProposal(id, { decision: "reject" });
            await p.catch(() => {});
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§exec-target-routing} directory `(target)` sets the working directory for an inline program", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-directory-"));
        try {
            await mkdir(join(root, "sub"));
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idD = deferred<number>();
            const p = ctx.engine.dispatch({
                statement: execStmt(null, "sub", "echo hi"),  // `sh (sub)` with a shell body
                workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idD.resolve(id),
            });
            const id = await idD.promise;
            const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
            const attrs = JSON.parse(row?.attrs ?? "{}") as { cwd: string | null; target: string | null; body: string };
            assert.equal(attrs.cwd, join(root, "sub"), "`(sub)` names where the body runs");
            assert.equal(attrs.target, null, "no program path — the body is the program");
            assert.equal(attrs.body, "echo hi", "the body is the shell program");
            ctx.engine.resolveProposal(id, { decision: "reject" });
            await p.catch(() => {});
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

for (const source of ["local", "file", "session"] as const) {
    test(`{§executor-subprocess-routing} ${source} script receives exact tokenized argv and workspace cwd`, async () => {
        await withWorkspace(async (ctx) => {
            const root = await mkdtemp(join(tmpdir(), "exec-arguments-"));
            try {
                await rootWorkspace(ctx.db, ctx.workspaceId, root);
                const program = 'let input = ""; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));';
                const filename = "script with spaces.mjs";
                await writeFile(join(root, filename), program);
                await seedEntryWithChannel(ctx.db, {
                    workspaceId: ctx.workspaceId, scheme: "workspace", pathname: "/script.mjs", content: program,
                });
                const argv = ["ARGUMENT_SENTINEL", "two words", "", "$(touch unwanted)"];
                const body = 'ARGUMENT_SENTINEL "two words" "" "$(touch unwanted)"';
                const statement: ExecStatement = {
                    ...execStmt("js", null, body),
                    target: source === "local" ? localPath(filename)
                        : source === "file" ? urlPath("file", join(root, filename))
                        : urlPath("workspace", "/script.mjs"),
                };
                const proposed = deferred<number>();
                const pending = ctx.engine.dispatch({
                    statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
                    loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                    onDispatch: (id) => proposed.resolve(id),
                });
                const id = await proposed.promise;
                ctx.engine.resolveProposal(id, { decision: "accept" });
                assert.equal((await pending).status, 200);
                await ctx.exec.idle();
                const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
                const { pathname } = JSON.parse(row!.attrs) as { pathname: string };
                const read = await ctx.engine.dispatch({
                    statement: readStmt(urlPath("js", pathname)),
                    workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
                    loopId: ctx.loopId, turnId: ctx.turnId, sequence: 2, origin: "model",
                });
                assert.equal(read.status, 200);
                assert.deepEqual(JSON.parse(String((read as { content?: string }).content)), { args: argv, input: "", cwd: root });
            } finally {
                await ctx.exec.idle();
                await rm(root, { recursive: true, force: true });
            }
        });
    });
}

test("{§exec-target-routing} a directory target with a body runs there; with nothing to run it is refused", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-empty-directory-"));
        try {
            await mkdir(join(root, "sub"));
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idD = deferred<number>();
            const asCwd = ctx.engine.dispatch({
                statement: execStmt(null, "sub", "pwd"),  // `sh (sub)` + body — the directory is where the body runs
                workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idD.resolve(id),
            });
            const id = await idD.promise;
            const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
            const attrs = JSON.parse(row?.attrs ?? "{}") as { cwd: string | null; target: string | null; body: string };
            assert.equal(attrs.cwd, join(root, "sub"), "the directory is the working directory");
            assert.equal(attrs.target, null, "and not a program target");
            assert.equal(attrs.body, "pwd");
            ctx.engine.resolveProposal(id, { decision: "reject" });
            await asCwd.catch(() => {});
            const asProgram = await ctx.engine.dispatch({
                statement: execStmt(null, "sub", ""),  // `sh (sub)` with no body — a directory is not a program
                workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 2, origin: "model",
            });
            assert.equal(asProgram.status, 400);
            assert.equal(asProgram.problem?.type, "https://problems.plurnk.xyz/scheme/exec/target-not-a-program");
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§exec-target-routing} an absent local target under a project root is refused before any proposal, naming the target and never the root", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-absent-"));
        try {
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idDeferred = deferred<number>();
            const result = await ctx.engine.dispatch({
                statement: execStmt(null, "missing.sh", ""),
                workspaceId: ctx.workspaceId,
                sessionId: ctx.sessionId,
                loopId: ctx.loopId,
                turnId: ctx.turnId,
                sequence: 1,
                origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            assert.equal(result.status, 400);
            const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({ id: await idDeferred.promise });
            assert.equal(row?.status_rx, 400);
            assert.notEqual(row?.state, "proposed", "nothing to propose: the target never existed");
            const rendered = JSON.stringify(result);
            assert.match(rendered, /target-not-found/);
            assert.ok(!rendered.includes(root), "{§fs-namespace} the refusal never names the host root it searched");
            assert.match(rendered, /"target":"missing\.sh"/, "the model's own target remains the structured fact");
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§exec-target-routing} a non-absence stat failure stops before effect admission with its cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-stat-failure-"));
        try {
            await writeFile(join(root, "not-a-directory"), "file");
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            try {
                const result = await ctx.engine.dispatch({
                    statement: execStmt(null, "not-a-directory/child.json", "true"),
                    workspaceId: ctx.workspaceId,
                    sessionId: ctx.sessionId,
                    loopId: ctx.loopId,
                    turnId: ctx.turnId,
                    sequence: 1,
                    origin: "model",
                });

                assert.equal(result.status, 500);
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/target-classification-failed");
                assert.equal(result.problem?.stage, "target-classification");
                assert.equal(result.problem?.target, "not-a-directory/child.json");
                assert.match(result.problem?.detail ?? "", /could not be inspected.*ENOTDIR/i);
                assert.equal(diagnostics.length, 1);
                assert.match(String(diagnostics[0]?.[0]), /Execution target classification failed/);
                const cause = diagnostics[0]?.[1];
                assert.ok(cause instanceof Error && "code" in cause && cause.code === "ENOTDIR");
            } finally {
                await ctx.exec.idle();
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

// applyResolution returns 200/"started" immediately; the spawn runs async.
// The dispatch outcome on the log entry is "started" — the SPAWN's exit
// result lives intact on the subscription row's close_result; close_status is
// its constrained relational projection and channels carry lifecycle state.

test("{§exec-executor-slot} sh: clean exit → channels at state=closed, stdout captured, subscription closed at 200", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt(null, null, "echo marker"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string; outcome: string | null }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        assert.equal(log?.outcome, "started", "dispatch outcome reflects when applyResolution returned");

        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow, `sh://${pathname} entry exists`);
        const stdout = await ctx.db.test_get_channel.get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "marker\n");
        assert.equal(stdout?.state, "closed");

        const sub = await ctx.db.test_get_subscription_by_entry.get<{ close_status: number | null; close_result: string | null }>({
            session_id: ctx.sessionId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200, "spawn's actual exit-0 lands on subscription.close_status");
        assert.deepEqual(JSON.parse(sub?.close_result ?? "null"), { status: 200, exitCode: 0 });
    });
});

test("{§executor-exit-code} sh: an exit code is the answer: channels closed, stderr captured, subscription closed at 200", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt(null, null, "echo oops >&2; exit 7"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };

        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow);
        const stderr = await ctx.db.test_get_channel.get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "oops\n");
        assert.equal(stderr?.state, "closed");

        const sub = await ctx.db.test_get_subscription_by_entry.get<{ close_status: number | null; close_result: string | null }>({
            session_id: ctx.sessionId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200);
        assert.deepEqual(JSON.parse(sub?.close_result ?? "null"), { status: 200, exitCode: 7 });
        const stderrRead = await ctx.engine.dispatch({
            statement: readStmt(urlPath("sh", pathname, "stderr")),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 2, origin: "model",
        });
        assert.equal(stderrRead.status, 200, `content wins over the producer's exit: ${JSON.stringify(stderrRead).slice(0, 200)}`);
        assert.match(JSON.stringify(stderrRead), /oops/, "the captured stderr is the READ's content");
    });
});

test("{§exec-executor-slot} execution: cwd defaults to workspace.project_root when statement target is null", async () => {
    // Writes a file via shell into "$PWD/<marker>", then asserts the file
    // exists at <project_root>/<marker> — proves cwd really was project_root.
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-cwd-default-"));
    const marker = `cwd-default-${crypto.randomUUID().slice(0, 6)}.txt`;
    try {
        await withWorkspace(async (ctx) => {
            await ctx.db.test_set_workspace_project_root.run({
                id: ctx.workspaceId, project_root: workspace,
            });
            const idDeferred = deferred<number>();
            const dispatchPromise = ctx.engine.dispatch({
                statement: execStmt(null, null, `echo here > ${marker}`),
                workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
                loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            ctx.engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
            await dispatchPromise;
            await ctx.exec.idle();

            // The file landed in the project_root, not in plurnk-service's cwd.
            const written = await readFile(join(workspace, marker), "utf8").catch(() => null);
            assert.equal(written, "here\n",
                `the execution's cwd should have defaulted to workspace.project_root (${workspace}); file ${marker} should exist there`);
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("{§execution-output-identity} js: runs code via -e and captures stdout", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("js", null, "console.log(2 + 3)"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "js", pathname,
        });
        assert.ok(entryRow);
        const stdout = await ctx.db.test_get_channel.get<{ content: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        // stdout reflects the subprocess's INHERITED env ({§execution-output-identity}) — a host FORCE_COLOR makes
        // node colorize the number (`\x1b[33m5\x1b[39m`). This test verifies stdout CAPTURE, not exact
        // bytes, so strip ANSI control codes before the equality (deterministic on any host).
        // oxlint-disable-next-line eslint/no-control-regex
        assert.equal((stdout?.content ?? "").replace(/\x1b\[[0-9;]*m/g, ""), "5\n");
    });
});

test("{§exec-executor-slot} execution: subscription row opens then closes; stream/event fires per chunk + transition", async () => {
    type Event = { workspaceId: number; entryId: number; channel: string; state: string; contentLength: number };
    const events: Event[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            streamEventNotify: (workspaceId, event) => events.push({ workspaceId, ...event }),
        });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-notify-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "exec notify test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, null, "echo one"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        const workspaceEvents = events.filter((e) => e.workspaceId === workspaceId);
        const chunkEvents = workspaceEvents.filter((e) => e.state === "active");
        const closedEvents = workspaceEvents.filter((e) => e.state === "closed");
        assert.ok(chunkEvents.length >= 1, "at least one chunk event for stdout");
        assert.equal(closedEvents.length, 2, "both stdout and stderr transition to closed");

        // Subscription row exists and is closed at 200.
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname: chunkEvents.length > 0
                ? (await db.test_get_entry_by_id.get<{ pathname: string }>({ id: chunkEvents[0].entryId }))!.pathname
                : "",
        });
        const sub = await db.test_get_subscription_by_entry.get<{ close_status: number | null }>({
            session_id: sessionId, entry_id: entryRow!.id,
        });
        assert.equal(sub?.close_status, 200);
    } finally { await db.close(); }
});
});

describe("Exec.effect", () => {
// {§exec-lifetime} {§exec-lifetime} The executor declares its effect; the
// service owns the policy. `host` runtimes (sh/js/python3) propose — a human gate.
// `read`/`pure` runtimes auto-run ungated: no proposal, no notification — but, like every
// exec, they background and stream their output ({§exec-stream}), not in-band.


















const execStmt = (runtime: string | null, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    // The default shell is explicit: a fixture with no runtime is an `sh` execution (plurnk-service #659).
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: target === null ? null : localPath(target),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

let pureToolN = 0;
const wire = async () => {
    const tag = `puretool${++pureToolN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = await testExecutors();
    engine.setExecutors(executors);
    const pureExe: Executor = new class extends BaseExecutor {
        get channels() { return { results: { mimetype: "application/json" } }; }
        async run({ write, setState }: ExecArgs) {
            write("results", '[{"n":1}]', "application/json");
            setState("results", "closed");
            return { status: 200 };
        }
        override effect(target: string | null): Effect {
            return target === null ? "pure" : "read";
        }
    }({ runtime: tag, glyph: "🔧" });
    engine.registerRuntime(tag, {
        executor: pureExe,
        namespaceOwner: { kind: "module", name: "pure fixture" },
        glyph: "🔧",
        summary: "Pure fixture.",
        invocation: {
            body: { role: "query", required: true },
            target: { role: "resource", required: false, kind: "resource" },
            example: { body: "SELECT 1;" },
        },
        details: "",
        available: true,
        detail: undefined,
    });
    schemes.registerRuntimeSchemes(executors); // {§executor-scheme-output} Register per-tag READ faces as daemon boot does.
    const workspaceId = await insertWorkspace(db, `effect-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, sessionId);
    const loopId = await insertLoop(db, sessionId, 1, "effect test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, exec, workspaceId, sessionId, loopId, turnId, tag };
};

test("{§exec-stream} effect-gating: pure runtime auto-runs ungated — no proposal, no in-band body", async () => {
    const { db, engine, exec, workspaceId, sessionId, loopId, turnId, tag } = await wire();
    try {
        // No target → pure → auto. dispatch resolves WITHOUT any
        // external resolveProposal call (the host path would hang here).
        const result = await engine.dispatch({
            statement: execStmt(tag, null, "SELECT 1 AS n;"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "a pure runtime must not leave a pending proposal — it skips the gate");
        assert.ok(result.status < 400, `auto-run resolved cleanly; got ${result.status}`);
        // No in-band receipt: like every exec it backgrounds + streams ({§exec-stream}); the output
        // reaches the model via the env-observation injector next turn, not here.
        assert.equal(result.body, undefined, "pure auto-run returns no in-band body — it streams");
        await exec.idle();
    } finally { await db.close(); }
});

test("{§exec-target-routing} effect-gating: a pure execution being applied is never discoverable as a client proposal", async () => {
    const { db, engine, exec, workspaceId, sessionId, loopId, turnId, tag } = await wire();
    const applyEntered = deferred<void>();
    const releaseApply = deferred<void>();
    const originalApply = exec.applyResolution.bind(exec);
    exec.applyResolution = async (args, ctx) => {
        applyEntered.resolve();
        await releaseApply.promise;
        return originalApply(args, ctx);
    };
    const idDeferred = deferred<number>();
    const dispatched = engine.dispatch({
        statement: execStmt(tag, null, "SELECT 1 AS n;"),
        workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        onDispatch: (id) => idDeferred.resolve(id),
    });
    try {
        const logEntryId = await idDeferred.promise;
        await applyEntered.promise;

        assert.deepEqual(engine.pendingProposalIds(), [], "effect-auto execution has no resolution waiter");
        assert.deepEqual(
            await engine.pendingProposals(workspaceId),
            [],
            "reconnect discovery cannot advertise an operation the public resolution seam does not own",
        );

        releaseApply.resolve();
        const result = await dispatched;
        assert.equal(result.status, 200);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 200);
        assert.equal((JSON.parse(row?.attrs ?? "{}") as { effect?: unknown }).effect, "pure");
    } finally {
        releaseApply.resolve();
        await dispatched.catch(() => undefined);
        await exec.idle();
        await db.close();
    }
});

// {§exec-target-routing} {§executor-sinks}: cwd and target remain distinct inputs.
test("{§exec-target-routing}: targetless pure runtime ignores workspace cwd and keeps a null target", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pure-ws-"));
    const { db, engine, exec, workspaceId, sessionId, loopId, turnId, tag } = await wire();
    try {
        await rootWorkspace(db, workspaceId, root);  // cwd now defaults to this dir
        const result = await engine.dispatch({
            statement: execStmt(tag, null, "SELECT 'Paris' AS capital;"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "pure runtime auto-runs ungated, no proposal");
        assert.ok(result.status < 400, `resolved cleanly with a project_root cwd; got ${result.status}`);
        // The output streams like every execution; a project directory never becomes the runtime's target.
        await exec.idle();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§exec-lifetime} effect-gating: sh (host) proposes — entry sits at 'proposed' awaiting a gate", async () => {
    const { db, engine, exec, workspaceId, sessionId, loopId, turnId } = await wire();
    try {
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(null, null, "echo hi"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed", "host runtime proposes — waits for a human");
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();
    } finally { await db.close(); }
});

test("{§exec-lifetime} one canonical target derives one preserved effect fact (#107)", async () => {
    const effectCalls: Array<{ target: string | null; argumentCount: number }> = [];
    const runs: Array<{ body: string; cwd: string | null; target: string | null; materialized?: string }> = [];
    const exe: Executor = new class extends BaseExecutor {
        get channels() { return { results: { mimetype: "application/json" } }; }
        async run({ body, cwd, target, setState }: ExecArgs) {
            runs.push({
                body,
                cwd,
                target,
                ...(target?.startsWith(ExecScratch.directory()) === true
                    ? { materialized: await readFile(target, "utf8") }
                    : {}),
            });
            setState("results", "closed");
            return { status: 200 };
        }
        override effect(target: string | null): Effect {
            effectCalls.push({ target, argumentCount: arguments.length });
            return target === null ? "pure" : "read";
        }
    }({ runtime: "tool", glyph: "🔧" });
    const registry = new ExecutorRegistry(new Map([["tool", {
        executor: exe,
        namespaceOwner: { kind: "module", name: "effect fixture" },
        glyph: "🔧",
        summary: "Effect fixture.",
        invocation: {
            body: { role: "fixture input", required: false },
            target: { role: "fixture script", required: false, kind: "script" },
            example: { body: "fixture" },
        },
        details: "",
        available: true,
        detail: undefined,
    }]]));
    const db = await openMigrated();
    const root = await mkdtemp(join(tmpdir(), "plurnk-effect-"));
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(registry);
    const workspaceId = await insertWorkspace(db, `canonical-effect-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "canonical effect");
    const turnId = await insertTurn(db, loopId, 1, 102);
    try {
        await writeFile(join(root, "data.txt"), "local data");
        await mkdir(join(root, "work"));
        await rootWorkspace(db, workspaceId, root);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/source",
            channel: "body",
            content: "scheme data",
            state: "static",
        });

        const schemeTarget = parsePath("workspace:///source#body");
        assert.ok(schemeTarget !== null);
        const statements: ExecStatement[] = [
            execStmt("tool", null, "inline"),
            execStmt("tool", "data.txt", "file input"),
            execStmt("tool", "work", "directory cwd"),
            { ...execStmt("tool", null, ""), runtime: "tool", target: schemeTarget },
            { ...execStmt("tool", null, "filter"), runtime: "tool", target: schemeTarget },
        ];
        const effects: Effect[] = [];
        for (const [index, statement] of statements.entries()) {
            let logEntryId: number | undefined;
            const result = await engine.dispatch({
                statement,
                workspaceId, sessionId, loopId, turnId,
                sequence: index + 1,
                origin: "model",
                onDispatch: (id) => { logEntryId = id; },
            });
            assert.equal(result.status, 200);
            assert.notEqual(logEntryId, undefined);
            const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId as number });
            effects.push((JSON.parse(row?.attrs ?? "{}") as { effect: Effect }).effect);
        }
        await exec.idle();

        assert.deepEqual(effectCalls, [
            { target: null, argumentCount: 1 },
            { target: "data.txt", argumentCount: 1 },
            { target: null, argumentCount: 1 },
            { target: "workspace:///source#body", argumentCount: 1 },
            { target: "workspace:///source#body", argumentCount: 1 },
        ], "effect() is called once against the canonical logical target and never receives body metadata");
        assert.deepEqual(effects, ["pure", "read", "pure", "read", "read"], "the admitted effect fact is persisted with each invocation");
        assert.deepEqual(runs.map(({ body, cwd, target, materialized }) => ({
            body,
            cwd: cwd === join(root, "work") ? "<directory>" : cwd,
            target: target?.startsWith(ExecScratch.directory()) === true ? "<materialized>" : target,
            ...(materialized === undefined ? {} : { materialized }),
        })), [
            { body: "inline", cwd: root, target: null },
            { body: "file input", cwd: root, target: "data.txt" },
            { body: "directory cwd", cwd: "<directory>", target: null },
            { body: "", cwd: root, target: "<materialized>", materialized: "scheme data" },
            { body: "filter", cwd: root, target: "<materialized>", materialized: "scheme data" },
        ], "run() receives the correctly routed local realization of the same invocation");
    } finally {
        await exec.idle();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§exec-lifetime} bare execution resolves to sh through the shared workspace capability policy", async () => {
    const { db, engine, exec, workspaceId, sessionId, loopId, turnId } = await wire();
    try {
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities: { deny: [{ runtime: "sh" }] } }),
        });
        const result = await engine.dispatch({
            statement: execStmt(null, null, "echo hi"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "workspace policy refuses the default sh runtime before proposal or spawn");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "sh");
        assert.equal(result.problem?.policyScope, "workspace");
        assert.equal(result.problem?.retryable, false);
        assert.equal(result.problem?.recovery, undefined);
        await exec.idle();
    } finally { await db.close(); }
});
});

describe("Exec.invocation", () => {
interface Run {
    readonly body: string;
    readonly cwd: string | null;
    readonly target: string | null;
    readonly metadata?: readonly string[];
    readonly materialized?: string;
}

const INVOCATIONS: Readonly<Record<string, RuntimeInvocationDecl>> = {
    literaltool: {
        body: { role: "JSON arguments", required: false },
        target: { role: "tool", required: true, kind: "literal" },
        example: { target: "fixture_tool", body: "{}" },
    },
    registrytool: {
        body: { role: "JSON arguments", required: false },
        target: { role: "registered tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    },
    bodyonly: {
        body: { role: "query", required: true },
        example: { body: "fixture query" },
    },
    pathtool: {
        body: { role: "operation", required: true },
        target: { role: "database", required: false, kind: "path" },
        example: { body: "inspect" },
    },
    resourcetool: {
        body: { role: "filter", required: false },
        target: { role: "input", required: false, kind: "resource" },
        example: { body: "inspect" },
    },
    exclusivetool: {
        body: { role: "inline query", required: false },
        target: { role: "query file", required: false, kind: "resource" },
        exclusive: true,
        example: { body: "SELECT 1" },
    },
};

const statement = (runtime: string, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: target === null ? null : parsePath(target),
    lineMarker: null,
    body,
    position: { line: 1, column: 1 },
});

const wire = async (resourcesPath?: string) => {
    const runs = new Map<string, Run[]>();
    const effects = new Map<string, Array<string | null>>();
    const entries = new Map([...Object.entries(INVOCATIONS)].map(([runtime, invocation]) => {
        const executor: Executor = {
            runtime,
            glyph: "?",
            get manifest(): SchemeManifest {
                return { ...schemeManifest(runtime, { results: "text/plain" }, "results"), volatile: true };
            },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/plain" } }; },
            async run(args: ExecArgs) {
                const materialized = runtime === "resourcetool" && args.target !== null
                    ? await readFile(args.target, "utf8")
                    : undefined;
                const runtimeRuns = runs.get(runtime) ?? [];
                runtimeRuns.push({
                    body: args.body,
                    cwd: args.cwd,
                    target: args.target,
                    ...(args.metadata == null ? {} : { metadata: args.metadata }),
                    ...(materialized === undefined ? {} : { materialized }),
                });
                runs.set(runtime, runtimeRuns);
                args.setState("results", "closed");
                return { status: 200 };
            },
            async probe() { return { available: true }; },
            effect(target) {
                const runtimeEffects = effects.get(runtime) ?? [];
                runtimeEffects.push(target);
                effects.set(runtime, runtimeEffects);
                return "pure";
            },
            ...(runtime === "literaltool" ? {
                async prepare(input: ExecInput) {
                    if (input.metadata?.includes("refuse")) {
                        return Results.failure("executor:fixture", "invalid-option", 400, "Fixture option was rejected.");
                    }
                    if (input.metadata?.includes("broken")) return { status: 200 };
                    return { status: 200, cwd: input.cwd };
                },
            } : {}),
            ...(runtime === "registrytool"
                ? {
                    toolRegistry() {
                        return {
                            tools: [{
                                target: "enabled_tool",
                                summary: "Use the enabled fixture tool.",
                                invocation: {
                                    body: { role: "required JSON arguments", required: true },
                                    target: { role: "Enabled fixture tool", required: true, kind: "literal" as const },
                                    signature: '{"value": string}',
                                },
                            }],
                        };
                    },
                }
                : {}),
        };
        return [runtime, {
            executor,
            namespaceOwner: { kind: "module" as const, name: `${runtime} fixture` },
            glyph: "?",
            summary: `${runtime} fixture.`,
            invocation,
            details: "",
            ...(resourcesPath === undefined ? {} : { resourcesPath }),
            available: true,
            detail: undefined,
        }] as const;
    }));
    const executors = new ExecutorRegistry(entries);
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.registerRuntimeSchemes(executors);
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    const workspaceId = await insertWorkspace(db, `exec-invocation-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "invocation contract");
    const turnId = await insertTurn(db, loopId, 1, 102);
    let sequence = 0;
    return {
        db,
        engine,
        runs,
        effects,
        workspaceId,
        sessionId,
        async dispatch(execStatement: ExecStatement) {
            const result = await engine.dispatch({
                statement: execStatement,
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence: ++sequence,
                origin: "model",
            });
            await exec.idle();
            return result;
        },
        async close() {
            await exec.idle();
            await schemes.close();
            await db.close();
        },
    };
};

test("{§exec-target-routing} literal targets survive directory collisions without filesystem interpretation", async () => {
    const ctx = await wire();
    const root = await mkdtemp(join(tmpdir(), "exec-literal-"));
    try {
        await mkdir(join(root, "tool_name"));
        await rootWorkspace(ctx.db, ctx.workspaceId, root);
        const result = await ctx.dispatch(statement("literaltool", "tool_name", "{}"));
        assert.equal(result.status, 200);
        assert.deepEqual(ctx.runs.get("literaltool"), [{ body: "{}", cwd: root, target: "tool_name" }]);
        assert.deepEqual(ctx.effects.get("literaltool"), ["tool_name"]);
    } finally {
        await ctx.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§executor-tool-registry} exact tools own admission and their invocation contract", async () => {
    const ctx = await wire();
    try {
        const reference = await ctx.engine.referenceEntries(ctx.workspaceId);
        const runtimeDoc = reference.find((doc) => doc.pathname === "/_plurnk/plurnk/registrytool.md");
        assert.match(runtimeDoc?.content ?? "", /```registrytool \(enabled_tool\)/, "the runtime document carries every registered target");
        assert.equal(
            reference.some((doc) => doc.pathname.startsWith("/_plurnk/plurnk/registrytool/")),
            false,
            "per-target child documents do not exist (#336)",
        );
        const missing = await ctx.dispatch(statement("registrytool", null, "{}"));
        assert.equal(missing.status, 400);
        assert.match(missing.problem?.type ?? "", /target-required$/);

        const disabled = await ctx.dispatch(statement("registrytool", "disabled_tool", "{}"));
        assert.equal(disabled.status, 404);
        assert.match(disabled.problem?.type ?? "", /target-not-registered$/);
        assert.equal(disabled.problem?.availableTargetCount, 1);
        assert.equal(disabled.problem?.recovery, "Select a target from workspace:///_plurnk/plurnk/registrytool.md.");
        assert.ok(reference.some(({ pathname }) => disabled.problem?.recovery === `Select a target from workspace://${pathname}.`),
            "recovery names a published runtime document, not an assumed schema directory");
        assert.equal("availableTargets" in (disabled.problem ?? {}), false);

        const missingBody = await ctx.dispatch(statement("registrytool", "enabled_tool", ""));
        assert.equal(missingBody.status, 400);
        assert.match(missingBody.problem?.type ?? "", /body-required$/);
        assert.equal(ctx.effects.has("registrytool"), false);

        const accepted = await ctx.dispatch(statement("registrytool", "enabled_tool", '{"value":"ok"}'));
        assert.equal(accepted.status, 200);
        assert.deepEqual(ctx.runs.get("registrytool"), [{
            body: '{"value":"ok"}',
            cwd: process.cwd(),
            target: "enabled_tool",
        }]);
        assert.deepEqual(ctx.effects.get("registrytool"), ["enabled_tool"]);
    } finally {
        await ctx.close();
    }
});

test("{§tools-resource-discovery} target recovery follows a runtime's declared document root", async () => {
    for (const resourcesPath of ["/tools", "/modules/custom"]) {
        const ctx = await wire(resourcesPath);
        try {
            const result = await ctx.dispatch(statement("registrytool", "missing", "{}"));
            assert.equal(result.status, 404);
            const documents = await ctx.engine.referenceEntries(ctx.workspaceId);
            const path = `/_plurnk${resourcesPath}/registrytool.md`;
            assert.equal(result.problem?.recovery, `Select a target from workspace://${path}.`);
            const document = documents.find(({ pathname }) => pathname === path);
            assert.ok(document, "the recovery document is actually published");
            assert.match(document.content, /enabled_tool/u);
        } finally { await ctx.close(); }
    }
});

test("{§executor-invocation} required and unsupported buckets are refused before execution", async () => {
    const ctx = await wire();
    try {
        const missingTarget = await ctx.dispatch(statement("literaltool", null, "{}"));
        assert.equal(missingTarget.status, 400);
        assert.match(missingTarget.problem?.type ?? "", /target-required$/);

        const unsupportedTarget = await ctx.dispatch(statement("bodyonly", "anything", "query"));
        assert.equal(unsupportedTarget.status, 400);
        assert.match(unsupportedTarget.problem?.type ?? "", /target-not-supported$/);

        const missingBody = await ctx.dispatch(statement("bodyonly", null, ""));
        assert.equal(missingBody.status, 400);
        assert.match(missingBody.problem?.type ?? "", /body-required$/);
        assert.equal(ctx.runs.has("literaltool"), false);
        assert.equal(ctx.runs.has("bodyonly"), false);
    } finally {
        await ctx.close();
    }
});

// {§executor-blank-invocation} Each blank an invocation can be: a registry runtime without its target, a registered target
// without its body, a required target or body absent, or neither supplied. Each fence names the target it shows and
// whether it carries a body.
const BLANKS = [
    { runtime: "registrytool", target: null, body: "{}", code: "target-required", fences: [["enabled_tool", true]] },
    { runtime: "registrytool", target: "enabled_tool", body: "", code: "body-required", fences: [["enabled_tool", true]] },
    { runtime: "literaltool", target: null, body: "{}", code: "target-required", fences: [["fixture_tool", true]] },
    { runtime: "bodyonly", target: null, body: "", code: "body-required", fences: [[null, true]] },
    { runtime: "pathtool", target: null, body: "", code: "body-required", fences: [[null, true]] },
    { runtime: "resourcetool", target: null, body: "", code: "input-required", fences: [[null, true]] },
] as const;
for (const blank of BLANKS) {
    test(`{§executor-blank-invocation}: ${blank.runtime}${blank.target === null ? "" : ` (${blank.target})`} refused as ${blank.code} answers with its working form`, async () => {
        const ctx = await wire();
        try {
            const result = await ctx.dispatch(statement(blank.runtime, blank.target, blank.body));
            assert.equal(result.status, 400);
            assert.match(result.problem?.type ?? "", new RegExp(`/${blank.code}$`, "u"));
            const { items } = PlurnkParser.parseStatements(String(result.problem?.recovery), { executors: [blank.runtime] });
            const fences = items.map((item) => {
                assert.ok(item.kind === "statement" && isExecution(item.statement) && item.statement.runtime === blank.runtime,
                    "the recovery is fences of the refused tool");
                return [item.statement.target?.raw ?? null, (item.statement.body ?? "").length > 0];
            });
            assert.deepEqual(fences, blank.fences, "showing the input the invocation lacked");
            assert.equal(ctx.runs.has(blank.runtime), false, "nothing ran");
        } finally {
            await ctx.close();
        }
    });
}

test("{§exec-target-routing} path targets remain targets and refuse non-file addresses", async () => {
    const ctx = await wire();
    const root = await mkdtemp(join(tmpdir(), "exec-path-"));
    try {
        await mkdir(join(root, "database"));
        await rootWorkspace(ctx.db, ctx.workspaceId, root);
        const local = await ctx.dispatch(statement("pathtool", "database", "inspect"));
        assert.equal(local.status, 200);
        assert.deepEqual(ctx.runs.get("pathtool"), [{ body: "inspect", cwd: root, target: "database" }]);

        const addressed = await ctx.dispatch(statement("pathtool", "workspace:///source", "inspect"));
        assert.equal(addressed.status, 400);
        assert.match(addressed.problem?.type ?? "", /target-kind-invalid$/);
        assert.equal(ctx.runs.get("pathtool")?.length, 1);
    } finally {
        await ctx.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§exec-target-routing} a resource target is always a target, including with an empty body", async () => {
    const ctx = await wire();
    try {
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "workspace",
            pathname: "/source",
            channel: "body",
            content: "resource bytes",
            state: "static",
        });
        const result = await ctx.dispatch(statement("resourcetool", "workspace:///source#body", ""));
        assert.equal(result.status, 200);
        const [run] = ctx.runs.get("resourcetool") ?? [];
        assert.equal(run?.body, "");
        assert.ok(run?.target?.startsWith(ExecScratch.directory()), "the source is realized under the scratch directory ({§exec-target-routing})");
        assert.equal(run?.materialized, "resource bytes");
        assert.deepEqual(ctx.effects.get("resourcetool"), ["workspace:///source#body"]);
    } finally {
        await ctx.close();
    }
});

test("{§executor-invocation} an exclusive runtime refuses body plus target", async () => {
    const ctx = await wire();
    try {
        const result = await ctx.dispatch(statement("exclusivetool", "query.sql", "SELECT 1"));
        assert.equal(result.status, 400);
        assert.match(result.problem?.type ?? "", /input-conflict$/);
        assert.equal(ctx.runs.has("exclusivetool"), false);
        assert.equal(ctx.effects.has("exclusivetool"), false);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} a tool owns opaque options even when its literal target looks like another scheme", async () => {
    const ctx = await wire();
    try {
        const request = {
            ...statement("literaltool", "unregistered://literal/tool", "raw body"),
            metadata: [" custom syntax ", "args=not a subprocess argument vector"],
        };
        const accepted = await ctx.dispatch(request);
        assert.equal(accepted.status, 200, JSON.stringify(accepted));
        assert.deepEqual(ctx.runs.get("literaltool"), [{
            body: "raw body", cwd: process.cwd(), target: "unregistered://literal/tool", metadata: request.metadata,
        }]);
        assert.deepEqual(ctx.effects.get("literaltool"), ["unregistered://literal/tool"]);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} absent and rejecting preparation refuse options before effect admission", async () => {
    const ctx = await wire();
    try {
        const unsupported = { ...statement("bodyonly", null, "query"), metadata: ["option"] };
        const rejected = await ctx.dispatch(unsupported);
        assert.equal(rejected.status, 400);
        assert.match(rejected.problem?.type ?? "", /metadata-unsupported$/);
        const refused = await ctx.dispatch({ ...statement("literaltool", "tool", ""), metadata: ["refuse"] });
        assert.equal(refused.status, 400);
        assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/executor/fixture/invalid-option");
        assert.equal(refused.problem?.detail, "Fixture option was rejected.");
        assert.equal(ctx.effects.size, 0);
        assert.equal(ctx.runs.size, 0);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} a malformed preparation is an internal failure before execution", async () => {
    const ctx = await wire();
    try {
        await assert.rejects(
            ctx.dispatch({ ...statement("literaltool", "tool", ""), metadata: ["broken"] }),
            (cause: unknown) => cause instanceof InvalidOperationResultError
                && /invalid invocation preparation/.test(cause.message),
        );
        assert.equal(ctx.effects.size, 0);
        assert.equal(ctx.runs.size, 0);
    } finally {
        await ctx.close();
    }
});
});

describe("Exec.scheme-source", () => {
type Actor = {
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    sequence: number;
};

type Run = {
    readonly body: string;
    readonly target: string | null;
    readonly metadata?: readonly string[];
    readonly materialized?: string;
};

const urlTarget = (raw: string): UrlPath => {
    const target = parsePath(raw);
    if (target?.kind !== "url") throw new Error(`Expected a URL target: ${raw}`);
    return target;
};

const execStatement = (target: string, body: string, metadata: string[] | null = null): ExecStatement => ({
    metadata,
    aside: null,
    runtime: "tool", target: urlTarget(target),
    lineMarker: null,
    body,
    position: { line: 1, column: 0 },
});

const runtimeManifest = (name: string): SchemeManifest => OutputScheme.manifestFromRuntime({
    name,
    channels: { results: "text/plain" },
    defaultChannel: "results",
});

const materializeSource = async (
    request: RepresentationPreparationRequest,
    ctx: SchemeCtx,
    content: string,
    channel = "body",
) => {
    const written = await ctx.entries.write(request.pathname, {
        channels: {
            [channel]: { content, mimetype: "text/plain" },
        },
    });
    assert.ok(written.status === 200 || written.status === 201);
    return { status: 200 } as const;
};

const wire = async (beforeRun?: () => Promise<void>): Promise<{
    readonly db: Awaited<ReturnType<typeof openMigrated>>;
    readonly engine: Engine;
    readonly exec: Exec;
    readonly schemes: SchemeRegistry;
    readonly workspaceId: number;
    readonly root: Actor;
    readonly runs: Run[];
    readonly wakes: WakeSessionPayload[];
    actor(parentSessionId: number | null, name: string): Promise<Actor>;
    dispatch(actor: Actor, target: string, body?: string, metadata?: string[] | null): Promise<Awaited<ReturnType<Engine["dispatch"]>>>;
    close(): Promise<void>;
}> => {
    const runs: Run[] = [];
    const wakes: WakeSessionPayload[] = [];
    const executor: Executor = {
        runtime: "tool",
        glyph: "🔧",
        get manifest(): SchemeManifest { return runtimeManifest("tool"); },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
        async prepare({ cwd }) { return { status: 200, cwd }; },
        async run({ body, target, metadata, setState }) {
            await beforeRun?.();
            runs.push({
                body,
                target,
                ...(metadata == null ? {} : { metadata }),
                ...(target === null ? {} : { materialized: await readFile(target, "utf8") }),
            });
            if (body === "replace-temporary-with-directory" && target !== null) {
                await rm(target);
                await mkdir(target);
            }
            setState("results", "closed");
            return { status: 200 };
        },
        async probe() { return { available: true }; },
        effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
    };
    const executors = new ExecutorRegistry(new Map([
        ["tool", {
            executor,
            namespaceOwner: { kind: "module", name: "scheme-source fixture" },
            glyph: "🔧",
            summary: "Scheme source fixture.",
            invocation: {
                body: { role: "fixture input", required: false },
                target: { role: "fixture resource", required: false, kind: "resource" },
                example: { body: "fixture" },
            },
            details: "",
            available: true,
            detail: undefined,
        }],
    ]));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.registerRuntimeSchemes(executors);
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({
        db,
        schemes,
        wakeSessionNotify: (payload) => { wakes.push(payload); },
    });
    engine.setExecutors(executors);
    const workspaceId = await insertWorkspace(db, `exec-source-${crypto.randomUUID()}`);
    const makeActor = async (parentSessionId: number | null, name: string): Promise<Actor> => {
        const sessionId = await insertSession(db, workspaceId, parentSessionId, name);
        const loopId = await insertLoop(db, sessionId, 1, `${name} source test`);
        const turnId = await insertTurn(db, loopId, 1, 102);
        return { sessionId, loopId, turnId, sequence: 0 };
    };
    const root = await makeActor(null, "root");
    return {
        db,
        engine,
        exec,
        schemes,
        workspaceId,
        root,
        runs,
        wakes,
        actor: makeActor,
        async dispatch(actor, target, body = "", metadata = null) {
            const result = await engine.dispatch({
                statement: execStatement(target, body, metadata),
                workspaceId,
                sessionId: actor.sessionId,
                loopId: actor.loopId,
                turnId: actor.turnId,
                sequence: ++actor.sequence,
                origin: "model",
            });
            await exec.idle();
            return result;
        },
        async close() {
            await exec.idle();
            await schemes.close();
            await db.close();
        },
    };
};

// {§exec-target-routing} {§exec-target-routing} A scheme-backed execution source
// is one exact ordinary READ; non-native sources use a spawn-scoped temporary.
test("{§op-methods-op-dispatch}: create, launch, and delete are ordered without waiting for an asynchronous executor", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    const gate = Promise.withResolvers<void>();
    const ctx = await wire(() => gate.promise);
    try {
        const source = "````EDIT (workspace:///script)\nsource code\n````\n````tool (workspace:///script)````\n````KILL (workspace:///script)````\n````NOTE\nContinue the task.\n````";
        const result = await ctx.engine.runTurn({
            workspaceId: ctx.workspaceId, sessionId: ctx.root.sessionId, loopId: ctx.root.loopId,
            messages: [], provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
        });
        const rows = await ctx.db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => ["EDIT", "tool", "KILL"].includes(op ?? "")).map(({ op, status_rx }) => [op, status_rx]), [
            ["EDIT", 201], ["tool", 200], ["KILL", 200],
        ]);
        assert.equal(await ctx.db.test_get_entry_id_by_pathname.get({ pathname: "/script" }), undefined, "cleanup has happened while the executor remains in flight");
        assert.equal(ctx.runs.length, 0, "dispatch does not imply process completion");
        gate.resolve();
        await ctx.exec.idle();
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), ["source code"], "execution acquired the source at its authored position before KILL");
    } finally {
        gate.resolve();
        await ctx.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§exec-target-routing} execution source READ preserves the complete authored scheme address (#163)", async () => {
    const ctx = await wire();
    const seen: RepresentationPreparationRequest[] = [];
    const completeSource = Array.from({ length: 20 }, (_, index) => `source line ${index + 1}`).join("\n");
    const raw = "source://alice:secret@example.test:8443/items/path?b=2&a=1&a=3#payload";
    try {
        ctx.schemes.register("source", {
            manifest: {
                ...schemeManifest("source", { payload: "text/plain" }, "payload"),
                metadataModifier: true,
            },
            async prepareRepresentation(request, schemeCtx) {
                seen.push(structuredClone(request));
                return materializeSource(request, schemeCtx, completeSource, "payload");
            },
        } satisfies SchemeHandler);

        const result = await ctx.dispatch(ctx.root, raw, "transform", ["Accept: text/plain", "X-Trace: one:two"]);

        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.pathname, "/example.test/items/path");
        const preparedTarget = seen[0]?.target;
        assert.equal(preparedTarget?.kind, "url");
        if (preparedTarget?.kind !== "url") throw new Error("source preparation lost its URL target");
        assert.equal(preparedTarget.username, "alice");
        assert.equal(preparedTarget.password, "secret");
        assert.equal(preparedTarget.hostname, "example.test");
        assert.equal(preparedTarget.port, 8443);
        assert.equal(preparedTarget.pathname, "/items/path");
        assert.equal(preparedTarget.query, "b=2&a=1&a=3");
        assert.equal(seen[0]?.metadata, null, "source acquisition does not inherit another tool's metadata");
        assert.deepEqual(ctx.runs[0]?.metadata, ["Accept: text/plain", "X-Trace: one:two"], "the invoked tool owns the ordered raw blocks");
        assert.equal(preparedTarget.fragment, null, "core withholds channel selection from acquisition");
        assert.deepEqual(ctx.runs.map(({ body, materialized }) => ({ body, materialized })), [
            { body: "transform", materialized: completeSource },
        ]);
        const tempPath = ctx.runs[0]?.target;
        assert.ok(tempPath !== null && tempPath !== undefined);
        await assert.rejects(
            readFile(tempPath, "utf8"),
            (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT",
            "the source temporary is removed after the executor settles",
        );
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} execution metadata does not require the source scheme to accept metadata", async () => {
    const ctx = await wire();
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                assert.equal(request.metadata, null);
                return materializeSource(request, schemeCtx, "program");
            },
        } satisfies SchemeHandler);
        const metadata = ["opaque tool option", " second block "];
        const result = await ctx.dispatch(ctx.root, "source:///script", "input", metadata);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.deepEqual(ctx.runs[0]?.metadata, metadata);
        assert.equal(ctx.runs[0]?.materialized, "program");
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} independent spawns never reuse one temporary identity", async () => {
    const first = await wire();
    const second = await wire();
    try {
        for (const [ctx, content] of [[first, "first"], [second, "second"]] as const) {
            ctx.schemes.register("source", {
                manifest: schemeManifest("source"),
                async prepareRepresentation(request, schemeCtx) {
                    return materializeSource(request, schemeCtx, content);
                },
            } satisfies SchemeHandler);
            const result = await ctx.dispatch(ctx.root, "source:///item");
            assert.equal(result.status, 200);
        }

        assert.notEqual(
            first.runs[0]?.target,
            second.runs[0]?.target,
            "identical database coordinates in separate daemon instances cannot alias in the host temporary directory",
        );
    } finally {
        await Promise.all([first.close(), second.close()]);
    }
});

test("{§exec-target-routing} cleanup failure preserves the settled result and complete diagnostic cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const ctx = await wire();
    let tempPath: string | null = null;
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                return materializeSource(request, schemeCtx, "temporary content");
            },
        } satisfies SchemeHandler);

        const started = await ctx.dispatch(ctx.root, "source:///item", "replace-temporary-with-directory");
        tempPath = ctx.runs[0]?.target ?? null;

        assert.equal(started.status, 200);
        assert.equal(ctx.wakes.length, 1);
        assert.equal(ctx.wakes[0]?.result.status, 200, "cleanup cannot rewrite the executor's settled result");
        assert.ok(tempPath !== null);
        assert.equal((await stat(tempPath)).isDirectory(), true, "the specimen leaves a real unlink failure behind");
        assert.equal(diagnostics.length, 1, "cleanup failure is diagnosed exactly once");
        assert.match(String(diagnostics[0]?.[0]), /Execution source temporary cleanup failed/);
        const cause = diagnostics[0]?.[1];
        assert.ok(cause instanceof Error);
        assert.equal("path" in cause ? cause.path : undefined, tempPath);
        assert.ok("code" in cause && (cause.code === "EISDIR" || cause.code === "EPERM"));
    } finally {
        if (tempPath !== null) await rm(tempPath, { recursive: true, force: true });
        await ctx.close();
    }
});

test("{§session-scheme} execution source READ preserves literal shared and named scratch identities", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.sessionId, "child");
        const sibling = await ctx.actor(ctx.root.sessionId, "sibling");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "workspace",
            pathname: "/script",
            content: "commons command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            authority: await SessionName.forId(ctx.db, ctx.root.sessionId),
            scheme: "session",
            pathname: "/script",
            content: "root command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            authority: await SessionName.forId(ctx.db, child.sessionId),
            scheme: "session",
            pathname: "/script",
            content: "child command",
        });

        const commonsRead = await ctx.dispatch(ctx.root, "workspace:///script#body");
        assert.equal(commonsRead.status, 200, JSON.stringify(commonsRead));
        assert.equal((await ctx.dispatch(ctx.root, `session://${await SessionName.forId(ctx.db, ctx.root.sessionId)}/script#body`)).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "session://child/script#body")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", "", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "commons command",
            "root command",
            "child command",
        ]);

        // {§session-scheme} — a sibling names another session's space and materializes it (#394).
        const named = await ctx.dispatch(sibling, "session://child/script#body");
        assert.equal(named.status, 200, JSON.stringify(named));
        assert.equal(ctx.runs.at(-1)?.materialized, "child command", "the sibling's execution materialized the named session's script");
        const unknown = await ctx.dispatch(ctx.root, "session://unknown/script#body");
        assert.equal(unknown.status, 404);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/scheme/session/entry-not-found");
        assert.equal(ctx.runs.length, 4, "failed source resolution never invokes the executor");
    } finally {
        await ctx.close();
    }
});

test("{§execution-output-identity}: execution source READ uses the same workspace output from either session", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.sessionId, "child");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "tool",
            pathname: "/aa123456",
            channel: "results",
            content: "root stream command",
            state: "closed",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "tool",
            pathname: "/bb234567",
            channel: "results",
            content: "child stream command",
            state: "closed",
        });

        assert.equal((await ctx.dispatch(ctx.root, "tool:///aa123456#results")).status, 200);
        assert.equal((await ctx.dispatch(child, "tool:///bb234567#results")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "root stream command",
            "child stream command",
        ]);
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} execution source eligibility and failures come from the owning READ contract (#163)", async () => {
    const ctx = await wire();
    let loggingPreparationCalled = false;
    try {
        const auditManifest = schemeManifest("audit");
        ctx.schemes.register("audit", {
            manifest: { ...auditManifest, category: "logging" },
            async prepareRepresentation() {
                loggingPreparationCalled = true;
                return { status: 200 };
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("writeonly", {
            manifest: schemeManifest("writeonly"),
        } satisfies SchemeHandler);
        ctx.schemes.register("absent", {
            manifest: schemeManifest("absent"),
            async prepareRepresentation() {
                return Results.failure(
                    "scheme:absent",
                    "representation-not-found",
                    404,
                    "The source representation does not exist.",
                );
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("failing", {
            manifest: schemeManifest("failing"),
            async prepareRepresentation() {
                return Results.failure(
                    "scheme:failing",
                    "source-refused",
                    409,
                    "The source owner refused this representation.",
                    {},
                    { retryable: false },
                );
            },
        } satisfies SchemeHandler);

        const logging = await ctx.dispatch(ctx.root, "audit:///event");
        assert.equal(logging.status, 501);
        assert.equal(logging.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/exec-source-not-data");
        assert.equal(loggingPreparationCalled, false);

        const writeonly = await ctx.dispatch(ctx.root, "writeonly:///item");
        assert.equal(writeonly.status, 404);
        assert.equal(writeonly.problem?.type, "https://problems.plurnk.xyz/scheme/writeonly/entry-not-found");
        // #425 F4 — the owning identity stays; the execution slot contract rides the recovery.
        assert.equal(writeonly.problem?.recovery, "The target `writeonly:///item` names the program resource; the body is its arguments.");

        const unknown = await ctx.dispatch(ctx.root, "unknown:///item");
        assert.equal(unknown.status, 501);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");

        const absent = await ctx.dispatch(ctx.root, "absent:///item");
        assert.equal(absent.status, 404);
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/absent/representation-not-found");
        // The recovery states the slot contract and never guesses that the missing resource was a tool call.
        assert.doesNotMatch(String(absent.problem?.recovery), /\[[a-z]+\] \(/, "execution does not guess that a missing resource was intended as a tool call");
        assert.equal(absent.problem?.recovery, "The target `absent:///item` names the program resource; the body is its arguments.");

        const failing = await ctx.dispatch(ctx.root, "failing:///item");
        assert.equal(failing.status, 409);
        assert.equal(failing.problem?.type, "https://problems.plurnk.xyz/scheme/failing/source-refused");
        assert.equal(failing.problem?.detail, "The source owner refused this representation.");
        assert.equal(ctx.runs.length, 0);
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} an own-scheme target that can never be a stream is a name for the run; a real stream id stays a source (#758)", async () => {
    const ctx = await wire();
    try {
        const labelled = await ctx.dispatch(ctx.root, "tool:///daemon-env", "print the environment");
        assert.equal(labelled.status < 400, true, `a label target with a body runs: ${labelled.status}`);
        assert.deepEqual(ctx.runs.map(({ body, target }) => ({ body, target })), [{ body: "print the environment", target: null }]);

        const stream = await ctx.dispatch(ctx.root, "tool:///0badcafe", "print the environment");
        assert.equal(stream.status, 404, "an eight-hex stream id is still read as the program source");
        assert.equal(ctx.runs.length, 1);

        const bodiless = await ctx.dispatch(ctx.root, "tool:///daemon-env", "");
        assert.equal(bodiless.status, 404, "without a body there is nothing else to run");
        assert.equal(ctx.runs.length, 1);
    } finally {
        await ctx.close();
    }
});

// {§exec-target-routing} — the recorded shape (#853, run99 qflash): ```sh (workspace:///_plurnk/plurnk/sh.md)```
// over `git checkout -- …` was accepted, realized as a host temporary the containerized runtime never saw,
// and failed as `cannot open /tmp/plurnk-exec-….md`.
test("{§exec-target-routing} {§diagnostic-observation} a generated reference target is refused at admission, saying what it is and nothing more", async () => {
    const ctx = await wire();
    try {
        const withBody = await ctx.dispatch(ctx.root, "workspace:///_plurnk/plurnk/tool.md", "git checkout -- src/_pytest/assertion/util.py");
        assert.equal(withBody.status, 400);
        assert.match(String(withBody.problem?.type), /\/target-is-documentation$/);
        assert.equal(withBody.problem?.detail, "`workspace:///_plurnk/plurnk/tool.md` is reference documentation the harness generated, not a program; tool cannot run it.");
        assert.equal(withBody.problem?.recovery, undefined, "the body is not presumed to be a command");
        const bodiless = await ctx.dispatch(ctx.root, "workspace:///_plurnk/tools/tool.md");
        assert.equal(bodiless.status, 400);
        assert.equal(bodiless.problem?.recovery, undefined);
        assert.equal(ctx.runs.length, 0, "nothing was realized or run");
    } finally {
        await ctx.close();
    }
});

// {§exec-target-routing} — the recorded shape (#882): ```sh (log:///…)``` was realized under host
// /tmp, which the bench's containerized runtime never mounts, and failed mid-run.
test("{§exec-target-routing} a standalone source is realized under the knob's directory and removed afterwards", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    const scratch = join(tmpdir(), `plurnk-scratch-${crypto.randomUUID()}`, "nested");
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = scratch;
    let ctx: Awaited<ReturnType<typeof wire>> | null = null;
    try {
        ctx = await wire();
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                return materializeSource(request, schemeCtx, "program");
            },
        } satisfies SchemeHandler);
        const result = await ctx.dispatch(ctx.root, "source:///script.py");
        assert.equal(result.status, 200, JSON.stringify(result));
        const target = ctx.runs[0]?.target;
        assert.ok(target !== null && target !== undefined);
        assert.equal(dirname(target), scratch, "the executor saw a path under the scratch directory");
        assert.match(basename(target), /^plurnk-exec-[0-9a-f-]{36}\.py$/u);
        assert.equal(ctx.runs[0]?.materialized, "program");
        assert.equal((await stat(scratch)).mode & 0o777, 0o700, "created on first use, private to the daemon");
        await assert.rejects(stat(target), { code: "ENOENT" }, "the source is removed after the run settles");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
        await ctx?.close();
        await rm(dirname(scratch), { recursive: true, force: true });
    }
});

test("{§exec-target-routing} an unusable scratch directory refuses the execution at admission", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    const occupied = join(tmpdir(), `plurnk-scratch-${crypto.randomUUID()}`);
    await writeFile(occupied, "not a directory");
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = occupied;
    let ctx: Awaited<ReturnType<typeof wire>> | null = null;
    try {
        ctx = await wire();
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation() {
                throw new Error("admission refused before any source was read");
            },
        } satisfies SchemeHandler);
        const refused = await ctx.dispatch(ctx.root, "source:///script");
        assert.equal(refused.status, 400);
        assert.match(String(refused.problem?.type), /\/scratch-unavailable$/u);
        assert.equal(
            refused.problem?.detail,
            `The execution scratch directory \`${occupied}\` named by PLURNK_SERVICE_EXEC_SCRATCH cannot be created or written (EEXIST), so the tool source \`source:///script\` cannot be realized.`,
        );
        assert.equal(
            refused.problem?.recovery,
            "The operator points PLURNK_SERVICE_EXEC_SCRATCH at a writable absolute directory the tool executor can also read; meanwhile, target a program file the executor can reach, or put the command beneath a tool heading with no target.",
        );
        assert.equal(refused.problem?.scratch, occupied);
        assert.equal(refused.problem?.configuration, "PLURNK_SERVICE_EXEC_SCRATCH");
        assert.equal(ctx.runs.length, 0, "nothing was realized or run");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
        await ctx?.close();
        await rm(occupied, { force: true });
    }
});
});

describe("effect-policy", () => {
// {§exec-lifetime} — the deployment override routes an otherwise-auto
// execution through the human gate: with `pure:propose`, a pure invocation (whose
// default admission is auto) lands in the proposed state and completes only
// after an explicit accept.















const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("{§exec-lifetime}: proposing pure routes an otherwise-auto execution through the human gate", async () => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_PURE;
    process.env.PLURNK_SERVICE_EFFECT_PURE = "propose";
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        const pureExe: Executor = new class extends BaseExecutor {
            get channels() { return { results: { mimetype: "application/json" } }; }
            async run({ write, setState }: ExecArgs) {
                write("results", "6\n", "application/json");
                setState("results", "closed");
                return { status: 200 };
            }
            override effect(): Effect { return "pure"; }
        }({ runtime: "calc", glyph: "∑" });
        engine.registerRuntime("calc", {
            executor: pureExe,
            namespaceOwner: { kind: "module", name: "calc fixture" },
            glyph: "∑",
            summary: "Pure calculation fixture.",
            invocation: {
                body: { role: "expression", required: true },
                example: { body: "1 + 2 + 3" },
            },
            details: "",
            available: true,
            detail: undefined,
        });
        schemes.registerRuntimeSchemes(executors);
        const workspaceId = await insertWorkspace(db, `effect-policy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "effect-policy");
        const turnId = await insertTurn(db, loopId, 1, 102);

        let logEntryId = -1;
        const dispatched = engine.dispatch({
            statement: execStmt("calc", "1 + 2 + 3"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => { logEntryId = id; },
        });
        // The execution's row exists once its dispatch reports it; a proposal holds it there.
        const row = await waitForDb(async () => logEntryId === -1 ? undefined : await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId }),
            (found) => found !== undefined);
        assert.equal(row?.state, "proposed", "the overridden pure execution proposes instead of auto-running");
        engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatched;
        await exec.idle();
        assert.equal(result.status, 200, "the accepted override-gated execution completes normally");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_PURE;
        else process.env.PLURNK_SERVICE_EFFECT_PURE = prior;
        await db.close();
    }
});

test("{§configuration-repair-path}: invalid effect policy settles the operation without execution or an orphan proposal", async (t) => {
    const key = "PLURNK_SERVICE_EFFECT_HOST";
    const prior = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    const db = await openMigrated();
    t.after(() => db.close());
    const dir = await mkdtemp(join(tmpdir(), "plurnk-invalid-effect-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "executed");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    engine.setExecutors(await testExecutors());
    const workspaceId = await insertWorkspace(db, `invalid-effect-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "invalid-effect");
    const turnId = await insertTurn(db, loopId, 1, 102);
    let logEntryId = -1;
    const result = await engine.dispatch({
        statement: execStmt("js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        onDispatch: (id) => { logEntryId = id; },
    });
    assert.equal(result.status, 503);
    assert.equal(result.problem?.key, key);
    const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({ id: logEntryId });
    assert.equal(row?.status_rx, 503);
    assert.notEqual(row?.state, "proposed");
    assert.deepEqual(await engine.pendingProposals(workspaceId), []);
    await (schemes.get("exec") as Exec).idle();
    await assert.rejects(access(marker), { code: "ENOENT" }, "the operation never executed");
});
});

describe("entry-owner", () => {
// {§execution-output-identity} {§execution-output-identity}













const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const streamRead = (scheme: string, hostname: string | null, pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: `${scheme}://${hostname ?? ""}${pathname}`, scheme, username: null, password: null, hostname, port: null, pathname, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§exec} fan-out: equal causal coordinates create distinct outputs shared by the workspace", async () => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_HOST;
    process.env.PLURNK_SERVICE_EFFECT_HOST = "auto";
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors); // {§exec} — per-tag faces let READ js:// resolve
        const exec = schemes.get("exec") as Exec;
        assert.ok(schemes.get("js"));
        const ws = await insertWorkspace(db, `owner-fanout-${crypto.randomUUID()}`);

        const parent = await insertSession(db, ws, null, "parent");
        const host = await insertSession(db, ws, parent, "extract-host");
        const hLoop = await insertLoop(db, host, 1, "host");
        const hTurn = await insertTurn(db, hLoop, 1, 102);
        const pool = await insertSession(db, ws, parent, "extract-pool");
        const pLoop = await insertLoop(db, pool, 1, "pool");
        const pTurn = await insertTurn(db, pLoop, 1, 102);

        await engine.dispatch({ statement: execStmt("js", 'console.log("db.internal")'), workspaceId: ws, sessionId: host, loopId: hLoop, turnId: hTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: execStmt("js", "console.log(5)"), workspaceId: ws, sessionId: pool, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        await exec.idle();

        const hostPath = new URL(await executionAddress(db, hTurn)).pathname;
        const poolPath = new URL(await executionAddress(db, pTurn)).pathname;
        assert.notEqual(hostPath, poolPath, "independent executions never alias because their causal coordinates match");
        const read = async (sessionId: number, statement: ReadStatement): Promise<EntryReadResult> => {
            const result = await clientRead(engine, db, { statement, workspaceId: ws, sessionId });
            Results.assertReadResult(result);
            return result as EntryReadResult;
        };
        for (const sessionId of [host, pool, parent]) {
            const hostRead = await read(sessionId, streamRead("js", null, hostPath));
            const poolRead = await read(sessionId, streamRead("js", null, poolPath));
            assert.equal(hostRead.status, 200);
            assert.match(hostRead.content ?? "", /db\.internal/);
            assert.equal(poolRead.status, 200);
            assert.match(poolRead.content ?? "", /^5$/m);
        }
        await db.test_delete_session.run({ id: host });
        assert.match((await read(parent, streamRead("js", null, hostPath))).content ?? "", /db\.internal/,
            "deleting the producer leaves its workspace output readable");
        const foreignWorkspace = await insertWorkspace(db, "foreign-output");
        const foreignSession = await insertSession(db, foreignWorkspace);
        const foreign = await clientRead(engine, db, { statement: streamRead("js", null, hostPath),
            workspaceId: foreignWorkspace, sessionId: foreignSession });
        assert.equal(foreign.status, 404, "the same address does not cross workspace boundaries");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_HOST;
        else process.env.PLURNK_SERVICE_EFFECT_HOST = prior;
        await db.close();
    }
});

test("{§execution-output-identity}: simultaneous claims retry collisions instead of reusing an output", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "output-collisions");
        const names = ["a1234567", "a1234567", "b2345678"];
        t.mock.method(ExecutionOutputs, "short", () => {
            const name = names.shift();
            assert.ok(name);
            return name;
        });
        const paths = await Promise.all([
            ExecutionOutputs.claim(db, workspaceId, "sh"),
            ExecutionOutputs.claim(db, workspaceId, "sh"),
        ]);
        assert.deepEqual(paths.toSorted(), ["/a1234567", "/b2345678"]);
    } finally { await db.close(); }
});

test("{§execution-output-identity} shared entries require only a workspace, not a synthetic Session", async () => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-commons-${crypto.randomUUID()}`);
        const row = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: ws, name: "commons" });
        assert.equal(row, undefined, "no synthetic commons Session is created");

        // The identity index holds ON the commons: a second insert at the same key conflicts —
        // the exact fragmentation a NULL owner would have allowed (NULLs are distinct under UNIQUE).
        await db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" });
        await assert.rejects(
            db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" }),
            /UNIQUE/,
            "the same (workspace, owner, scheme, authority, pathname) key conflicts — no silent duplicate",
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity}: unnamed model sessions retry occupied names; explicit names retain their validation", async (t) => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-name-${crypto.randomUUID()}`);
        const names = ["ab3d5678", "ab3d5678", "bc4e6789", "cd5f7890", "de6a8901"];
        t.mock.method(SessionName, "short", () => {
            const name = names.shift();
            assert.ok(name !== undefined);
            return name;
        });
        const first = await Envelope.createModelSession(db, ws);
        assert.equal(first.name, "ab3d5678");
        const second = await Envelope.createModelSession(db, ws);
        assert.equal(second.name, "bc4e6789", "a generated name never reuses another session's identity");
        await Envelope.createModelSession(db, ws, "cd5f7890");
        const afterOccupiedLiteral = await Envelope.createModelSession(db, ws);
        assert.equal(afterOccupiedLiteral.name, "de6a8901", "explicit and generated names share the same namespace");

        assert.equal((await Envelope.createModelSession(db, ws, "commons")).name, "commons");
        await assert.rejects(Envelope.createModelSession(db, ws, "_plurnk"), SessionNameError, "the runtime actor's name is not mintable");
        assert.equal((await Envelope.createModelSession(db, ws, "plurnk")).name, "plurnk", "plurnk is an ordinary literal session name");
        await assert.rejects(Envelope.createModelSession(db, ws, "~"), SessionNameError, "tilde is not a session name");
        assert.equal((await Envelope.createModelSession(db, ws, "self")).name, "self", "self is an ordinary literal session name");
    } finally { await db.close(); }
});
});

describe("exec-concurrency", () => {
const statement = (body: string): ExecStatement => ({
    metadata: null,
    runtime: "controlled",
    aside: null,
    target: null,
    lineMarker: null,
    body,
    position: { line: 1, column: 1 },
});

const killStatement = (scheme: string, pathname: string): KillStatement => ({
    metadata: null,
    op: "KILL",
    aside: null,
    target: {
        kind: "url",
        raw: `${scheme}://${pathname}`,
        scheme,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

class ControlledExecutor implements Executor {
    readonly runtime = "controlled";
    readonly glyph = "?";
    readonly starts: string[] = [];
    readonly #gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    #releaseFuture = false;

    // A runtime executor authors no manifest of its own: the face derives the read-only-output
    // default from its runtime declaration ({§executor-scheme-output}), exactly like `sh`.
    get manifest() {
        return OutputScheme.manifestFromRuntime({ name: "controlled", glyph: "?", channels: { results: "text/plain" }, defaultChannel: "results" });
    }

    get defaultChannel(): string { return "results"; }
    get channels() { return { results: { mimetype: "text/plain" } }; }
    probe() { return Promise.resolve({ available: true }); }
    effect() { return "pure" as const; }

    async run(args: ExecArgs): Promise<ExecResult> {
        this.starts.push(args.body);
        const gate = Promise.withResolvers<void>();
        this.#gates.set(args.body, gate);
        if (this.#releaseFuture) gate.resolve();
        await gate.promise;
        args.setState("results", "closed");
        return { status: 200 };
    }

    release(body: string): void {
        this.#gates.get(body)?.resolve();
    }

    releaseAll(): void {
        this.#releaseFuture = true;
        for (const gate of this.#gates.values()) gate.resolve();
    }
}

const registry = (executor: ControlledExecutor): ExecutorRegistry => {
    const entry: RegistryEntry = {
        executor,
        namespaceOwner: { kind: "module", name: "controlled concurrency fixture" },
        glyph: executor.glyph,
        summary: "Blocks until the fixture releases it.",
        invocation: { body: { role: "fixture id", required: true }, signature: "<fixture id>" },
        details: "",
        available: true,
        detail: undefined,
    };
    return new ExecutorRegistry(new Map([[executor.runtime, entry]]));
};

const eventually = async (predicate: () => boolean, message: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail(message);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
};

test("{§exec-lifetime}: execution admission is FIFO and workspace-scoped", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "2";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = registry(executor);
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    try {
        const workspaceA = await insertWorkspace(db, `exec-cap-a-${crypto.randomUUID()}`);
        const sessionA1 = await insertSession(db, workspaceA);
        const sessionA2 = await insertSession(db, workspaceA);
        const loopA1 = await insertLoop(db, sessionA1, 1);
        const loopA2 = await insertLoop(db, sessionA2, 1);
        const turnA1 = await insertTurn(db, loopA1, 1, 102);
        const turnA2 = await insertTurn(db, loopA2, 1, 102);

        const workspaceB = await insertWorkspace(db, `exec-cap-b-${crypto.randomUUID()}`);
        const sessionB = await insertSession(db, workspaceB);
        const loopB = await insertLoop(db, sessionB, 1);
        const turnB = await insertTurn(db, loopB, 1, 102);

        const dispatch = (
            body: string,
            workspaceId: number,
            sessionId: number,
            loopId: number,
            turnId: number,
            sequence: number,
        ) => engine.dispatch({
            statement: statement(body),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin: "model",
        });

        assert.deepEqual(
            await dispatch("a1", workspaceA, sessionA1, loopA1, turnA1, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a2", workspaceA, sessionA2, loopA2, turnA2, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a3", workspaceA, sessionA1, loopA1, turnA1, 2),
            { status: 202, outcome: "queued", executionsAhead: 2, concurrency: 2 },
        );
        assert.deepEqual(
            await dispatch("a4", workspaceA, sessionA2, loopA2, turnA2, 2),
            { status: 202, outcome: "queued", executionsAhead: 3, concurrency: 2 },
        );
        assert.deepEqual(executor.starts, ["a1", "a2"], "siblings share the workspace limit");

        assert.deepEqual(
            await dispatch("b1", workspaceB, sessionB, loopB, turnB, 1),
            { status: 200, outcome: "started" },
            "another workspace has independent capacity",
        );
        await eventually(() => executor.starts.includes("b1"), "the other workspace never entered its available slot");

        executor.release("a1");
        await eventually(() => executor.starts.includes("a3"), "the oldest queued execution never started");
        assert.equal(executor.starts.includes("a4"), false, "one released slot starts exactly one queued execution");
        executor.release("a2");
        await eventually(() => executor.starts.includes("a4"), "the second queued execution never started");
        assert.deepEqual(
            executor.starts.filter((body) => body.startsWith("a")),
            ["a1", "a2", "a3", "a4"],
            "same-workspace admission is FIFO across sessions",
        );
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-lifetime}: KILL cancels queued work without invoking its executor", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = registry(executor);
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    try {
        const workspaceId = await insertWorkspace(db, `exec-cancel-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (body: string, sequence: number, onDispatch?: (id: number) => void) => engine.dispatch({
            statement: statement(body), workspaceId, sessionId, loopId, turnId, sequence, origin: "model", onDispatch,
        });

        assert.deepEqual(await dispatch("running", 1), { status: 200, outcome: "started" });
        let queuedLogId = 0;
        assert.deepEqual(
            await dispatch("cancel-me", 2, (id) => { queuedLogId = id; }),
            { status: 202, outcome: "queued", executionsAhead: 1, concurrency: 1 },
        );
        assert.deepEqual(executor.starts, ["running"]);
        const queuedLog = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: queuedLogId });
        const pathname = (JSON.parse(queuedLog?.attrs ?? "{}") as { pathname?: string }).pathname;
        assert.ok(pathname);

        const killed = await engine.dispatch({
            statement: killStatement("controlled", pathname),
            workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "model",
        });
        assert.equal(killed.status, 200);
        executor.release("running");
        await exec.idle();
        assert.deepEqual(executor.starts, ["running"], "cancelled queued work never enters the executor");

        const terminal = await engine.dispatch({
            statement: killStatement("controlled", pathname),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        // #757 — a KILL of an ended stream succeeds and reports how it ended.
        assert.equal(terminal.status, 200);
        assert.equal((terminal as { terminalStatus?: number }).terminalStatus, 200, "{§stream-asked-stop}: queued work its holder killed concludes as asked");
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-lifetime}: queue residence does not consume the execution timeout", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const executors = registry(executor);
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    try {
        const workspaceId = await insertWorkspace(db, `exec-timeout-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, executors });
        const attrs = (body: string, pathname: string, timeoutSec?: number) => ({
            runtime: "controlled",
            cwd: null,
            target: null,
            body,
            pathname,
            effect: "pure",
            ...(timeoutSec === undefined ? {} : { timeoutSec }),
        });

        assert.deepEqual(
            await exec.applyResolution({ attrs: attrs("running", "/1/1/1"), metadata: null }, ctx),
            { status: 200, outcome: "started" },
        );
        assert.equal(
            (await exec.applyResolution({ attrs: attrs("timed", "/1/1/2", 0.03), metadata: null }, ctx)).status,
            202,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(executor.starts, ["running"], "the queued timeout has not admitted the executor");

        executor.release("running");
        await eventually(() => executor.starts.includes("timed"), "queued work was already timed out before admission");
        executor.release("timed");
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});
});

describe("exec-detached", () => {
// {§exec-lifetime} — `[{"lifetime":"detached"}]` outlives the loop (#494): the spawn survives its loop's own 200,
// is no obligation for that completion, and still ends with the daemon.










let prevDetachedWaitMs: string | undefined;
beforeAll(() => {
    prevDetachedWaitMs = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
});
afterAll(() => {
    if (prevDetachedWaitMs === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prevDetachedWaitMs;
});

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A host exec that never exits on its own and leaves a heartbeat the test can read from outside.
const heartbeat = (file: string) => `while true; do date +%s%N > ${file}; sleep 0.05; done`;
const beat = async (file: string): Promise<string> => (await readFile(file, "utf8").catch(() => "")).trim();
const beating = async (file: string, ms: number): Promise<boolean> => {
    const before = await beat(file);
    await delay(ms);
    return before !== await beat(file);
};

test("{§exec-lifetime} a detached spawn is observed once, then outlives its loop and ends with the daemon", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const dir = await mkdtemp(join(tmpdir(), "exec-detached-"));
    const file = join(dir, "beat");
    try {
        const mock = new Mock({
            contextWindow: viableWindow(),
            responses: [mockTurn(`\`\`\`\`sh [{"lifetime": "detached"}]
${heartbeat(file)}
\`\`\`\`

\`\`\`\`SEND
the server stays up
\`\`\`\`
\`\`\`\`SEND
\`\`\`\``), mockTurn("````SEND [200]\n````")],
        });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-detached" });
                const concluded = subscribeNotifications(ws, "stream/concluded");
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "leave a server running" });
                const loopId = (run.result as { loopId: number }).loopId;

                // The detached stream remains live after its invocation is observed.
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 10000 },
                );
                await waitForDb(() => beat(file), (b) => b !== "", { timeoutMs: 5000 });
                assert.equal(mock.received.length, 2, "the invocation still requires a packet before completion");
                assert.equal(mock.remaining, 0);
                assert.equal(await beating(file, 400), true, "the detached spawn keeps running after the loop's 200");
                assert.equal(
                    (concluded() as Array<{ scheme: string }>).some((c) => c.scheme === "sh"),
                    false,
                    "no reap concluded the detached stream at loop end",
                );
            } finally { ws.close(); }
        });
        // withDaemon stopped the daemon: a detached spawn does not outlive it.
        await waitForDb(() => beating(file, 300), (moving) => ! moving, { timeoutMs: 10000 });
    } finally { await rm(dir, { recursive: true, force: true }); }
});
});

describe("exec-env-scoping", () => {
// SPEC {§exec} {§execution-output-identity} — an execution subprocess must NOT inherit plurnk's own
// secrets (provider keys, PLURNK_* config). The service scopes the env (ExecEnv.scoped:
// drop PLURNK_* + the provider key-vars) and hands it to the executor, which spawns with
// it (plurnk-execs 0.4.5+ ExecArgs.env). The canary is a PLURNK_*-shaped var, so the
// denylist drops it before the spawn.











const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

test(
    "{§execution-output-identity} an execution subprocess does not inherit plurnk's own env (provider keys / PLURNK_*)",
    async () => {
        const CANARY = "PLURNK_ENV_LEAK_CANARY";
        const prev = process.env[CANARY];
        process.env[CANARY] = "do-not-leak-to-subprocess";
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const workspaceId = await insertWorkspace(db, `exec-env-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "exec env scoping");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: dslExecStmt(null, `echo "$${CANARY}"`),  // host runtime → propose
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            await exec.idle();

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
            const stdout = await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" });
            assert.doesNotMatch(stdout?.content ?? "", /do-not-leak-to-subprocess/, "plurnk's own env must not reach the execution subprocess");
        } finally {
            await db.close();
            if (prev === undefined) delete process.env[CANARY]; else process.env[CANARY] = prev;
        }
    },
);

// {§execution-output-identity} the ceiling. The witness above uses a PLURNK_-prefixed canary, so it
// proves only the invariant and passes under any policy. This one proves the allowlist: an
// ordinary host name the policy does not admit never reaches the spawn, while one it does
// admit arrives intact — the distinction a denylist could not make.
test(
    "{§execution-output-identity} an execution subprocess inherits only the ambient names the policy admits",
    async () => {
        const ADMITTED = "PLURNK_TEST_ADMITTED_NAME";
        const WITHHELD = "AGENT_SOCKET_CANARY";
        const previous = {
            inherit: process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT,
            admitted: process.env[ADMITTED],
            withheld: process.env[WITHHELD],
        };
        // The admitted name is deliberately NOT PLURNK_-prefixed in the spawn's view: the
        // policy names it, and the invariant would strip a PLURNK_ name regardless.
        const ADMITTED_IN_ENV = "PROJECT_TOOL_HOME";
        process.env[ADMITTED_IN_ENV] = "/opt/tool";
        process.env[WITHHELD] = "/run/user/1000/keyring/ssh";
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = `PATH,HOME,${ADMITTED_IN_ENV}`;
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const workspaceId = await insertWorkspace(db, `exec-env-ceiling-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "exec env ceiling");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: dslExecStmt(null, `echo "admitted=$${ADMITTED_IN_ENV} withheld=$${WITHHELD}"`),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            await exec.idle();

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
            const stdout = (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            assert.match(stdout, /admitted=\/opt\/tool/, "a policy-admitted ambient name reaches the subprocess");
            assert.match(stdout, /withheld=$/mu, "an ambient name the policy does not admit is absent, not empty-stringed by the shell alone");
            assert.doesNotMatch(stdout, /keyring/, "the agent socket never reaches a model-written command");
        } finally {
            await db.close();
            delete process.env[ADMITTED_IN_ENV];
            if (previous.inherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previous.inherit;
            if (previous.withheld === undefined) delete process.env[WITHHELD]; else process.env[WITHHELD] = previous.withheld;
            if (previous.admitted === undefined) delete process.env[ADMITTED]; else process.env[ADMITTED] = previous.admitted;
        }
    },
);

// {§execution-output-identity} layer four — the Session's own state over the ambient ceiling, read at the spawn.
// The row is what the env verbs persist ({§functionality-scope}); here it is written directly so the
// spawn is witnessed alone: an enabled session entry sets its value, a disabled entry masks an ambient
// name for this Session only, a sibling with no row sees the ceiling untouched, and the invariant strips
// a reserved name even when the state names it.
test(
    "{§execution-output-identity} a Session's own environment reaches its next spawn; its sibling's ceiling is untouched",
    async () => {
        const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        const previousCi = process.env.CI;
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,CI";
        process.env.CI = "1";
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const workspaceId = await insertWorkspace(db, `exec-env-session-${crypto.randomUUID()}`);
            const shaped = await insertSession(db, workspaceId);
            const plain = await insertSession(db, workspaceId);
            await db.session_module_state_put.run({
                session_id: shaped, namespace_owner: "@plurnk/plurnk-service",
                state: JSON.stringify({ version: 1, definitions: {
                    CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
                    CI: { origin: "service", enabled: false },
                    PLURNK_SERVICE_LEAK: { origin: "session", enabled: true, definition: { value: "never" } },
                } }),
            });
            const stdoutOf = async (sessionId: number): Promise<string> => {
                const loopId = await insertLoop(db, sessionId, 1, "exec env session state");
                const turnId = await insertTurn(db, loopId, 1, 102);
                const idDeferred = deferred<number>();
                const dispatchPromise = engine.dispatch({
                    statement: dslExecStmt(null, 'echo "target=[$CARGO_TARGET_DIR] ci=[$CI] leak=[$PLURNK_SERVICE_LEAK]"'),
                    workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                    onDispatch: (id) => idDeferred.resolve(id),
                });
                const logEntryId = await idDeferred.promise;
                engine.resolveProposal(logEntryId, { decision: "accept" });
                await dispatchPromise;
                await exec.idle();
                const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
                const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
                const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
                return (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            };
            assert.match(await stdoutOf(shaped), /target=\[\/tmp\/shared\] ci=\[\] leak=\[\]/,
                "the Session's value is set, its masked ambient name is withheld, and a reserved name never reaches the command");
            assert.match(await stdoutOf(plain), /target=\[\] ci=\[1\] leak=\[\]/, "a sibling with no state sees the ceiling untouched");
        } finally {
            await db.close();
            if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
            if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        }
    },
);

// {§host-path-layout} {§execution-output-identity} — when a daemon runs with an isolated HostPaths, its
// subprocesses, env:///READ, and operatorEnvironment() all see the daemon's resolved HOME rather
// than leaking into the operator's ambient process.env.HOME (#1224).
test(
    "{§host-path-layout} {§execution-output-identity} a daemon with an isolated HostPaths projects its HOME into subprocesses, env:///HOME, and operatorEnvironment",
    async () => {
        const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME";
        const isolatedHome = `/tmp/plurnk-isolated-home-${crypto.randomUUID()}`;
        const hostPaths = new HostPaths({ home: isolatedHome, env: {} });
        const db = await openMigrated();
        const daemon = new Daemon({ db, hostPaths });
        await daemon.start();
        try {
            assert.equal(daemon.operatorEnvironment().HOME, isolatedHome, "module launch base carries the daemon's isolated HOME");
            const { workspaceId } = await daemon.createWorkspace({ name: `isolated-home-${crypto.randomUUID()}` });
            await daemon.activateWorkspace({ workspaceId });
            const { sessionId } = await daemon.createSession({ workspaceId });
            const sessionEnv = (await daemon.readSessionEnvironment(workspaceId, sessionId))();
            assert.equal(sessionEnv.HOME, isolatedHome, "session environment resolves HOME to the daemon's HostPaths.home");

            const loopId = await insertLoop(db, sessionId, 1, "isolated home");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const envRead = await daemon.engine.dispatch({
                statement: readStmt(urlPath("env", "/HOME")),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(envRead.status, 200);
            assert.equal(envRead.content, isolatedHome, "READ (env:///HOME) matches the daemon's isolated HOME");

            const idDeferred = deferred<number>();
            const dispatchPromise = daemon.engine.dispatch({
                statement: dslExecStmt(null, 'printf "%s" "$HOME"'),
                workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            daemon.engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            const exec = daemon.schemes.get("exec") as Exec;
            await exec.idle();

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
            const stdout = (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            assert.equal(stdout, isolatedHome, "subprocess $HOME resolves to the daemon's isolated HostPaths.home");
        } finally {
            await daemon.stop();
            await db.close();
            if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        }
    },
);
});

describe("exec-hold", () => {
// {§exec-lifetime} — runtimes in
// PLURNK_SERVICE_EXEC_HOLD pause the cycle until their stream concludes, so the model never
// burns a turn waiting on a result the engine controls end-to-end. Bounded + fail-open.












// This file isolates the hold decision after ordinary optimistic settlement:
// disabling the latter keeps the selected-vs-unselected runtime distinction as
// the only variable under test.
let prevHoldWaitMs: string | undefined;
beforeAll(() => {
    prevHoldWaitMs = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
});
afterAll(() => {
    if (prevHoldWaitMs === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prevHoldWaitMs;
});

const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

let wireN = 0;
const wire = async (finishAfterMs: number, effect: "read" | "host" | "pure" = "pure") => {
    // unique tag per wiring: testExecutors() is a shared cached registry — a duplicate
    // runtime registration throws and leaks the just-opened db, wedging the test file.
    const tag = `holdstub${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, channels: { results: "application/json" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "application/json" } }; },
            effect: () => effect,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                await new Promise((r) => setTimeout(r, finishAfterMs));
                args.write("results", JSON.stringify([{ title: "HOLD-DONE" }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "?", summary: "Hold fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    });
    const workspaceId = await insertWorkspace(db, `hold-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "hold test");
    return { db, engine, schemes, workspaceId, sessionId, loopId, tag };
};

const streamsSection = (packetJson: string): string => {
    const p = JSON.parse(packetJson) as { sections?: Array<{ name: string; content: string }> };
    return p.sections?.find((s) => s.name === "work")?.content ?? "";
};

const driveLoop = async (finishAfterMs: number, midTurns: number, effect: "read" | "host" | "pure" = "pure", holdSuffix?: string) => {
    const { db, engine, schemes, workspaceId, sessionId, loopId, tag } = await wire(finishAfterMs, effect);
    // The effect-qualified selector uses the runtime's actual registered tag.
    if (holdSuffix !== undefined) process.env.PLURNK_SERVICE_EXEC_HOLD = `${tag}${holdSuffix}`;
    try {
        const responses = [
            { assistant: { content: "", reasoning: null, ops: [execStmt(tag, "go"), noteStmt("searching")] } },
            ...Array.from({ length: midTurns }, () => ({ assistant: { content: "", reasoning: null, ops: [dispositionStmt("WAIT", "waiting on the monitored stream")] } })),
            { assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } },
        ];
        const provider = new Mock({ contextWindow: 100000, responses: responses });
        const t0 = Date.now();
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }], maxTurns: 5 });
        const elapsed = Date.now() - t0;
        const turn2 = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds[2] });
        return { result, elapsed, streams: streamsSection(turn2?.packet ?? "{}"), tag };
    } finally {
        await (schemes.get("exec") as Exec).idle();
        await db.close();
    }
};

test("{§exec-lifetime} a HOLD runtime pauses the cycle — turn 2 assembles AFTER the stream concludes", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "holdstub1";
    try {
        const { result, elapsed, streams } = await driveLoop(800, 0);
        assert.equal(result.result.status, 200);
        assert.ok(elapsed >= 800, `the cycle paused for the stream (elapsed ${elapsed}ms >= 800ms)`);
        assert.ok(!/holdstub1/.test(streams), "turn 2's packet lists no live holdstub stream after its completion");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("{§exec-lifetime} a runtime OUTSIDE the hold set keeps the standard cycle — turn 2 sees the live stream", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "some-other-runtime";
    try {
        // The standard cycle: T2 assembles immediately with the live stream
        // and parks on it (this direct Engine fixture has no daemon wake owner).
        const { result, streams } = await driveLoop(1200, 1);
        assert.equal(result.result.status, 202, "the unheld stream enters the ordinary monitored lifecycle");
        assert.ok(/holdstub2/.test(streams), "turn 2's packet LISTS the live stream — no hold applied outside the set");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("{§exec-lifetime}: a `:read` delimiter holds a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { elapsed, streams } = await driveLoop(400, 0, "read", ":read");
        assert.ok(!/holdstub/.test(streams), "turn 2 observed completion — the read-effect spawn was held by its :read delimiter");
        assert.ok(elapsed >= 350, "the cycle actually paused for the stream (held, not raced)");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});

test("{§exec-lifetime}: a `:host` delimiter does not hold a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { result, streams } = await driveLoop(2000, 1, "read", ":host");
        assert.equal(result.result.status, 202, "the mismatched selector leaves the stream monitored");
        assert.ok(/holdstub/.test(streams), "turn 2 saw the LIVE stream — a read spawn is not held by a :host delimiter");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});
});

describe("exec-lifetime", () => {
// {§exec-lifetime} — the fence states how long its run may live, and nothing else. The scope slot
// is text coordinates, which an execution has none of; an unreadable lifetime is refused by name
// before anything spawns. Real daemon, real `sh`, no proposal review (the run is consented).







const refusal = async (fence: string, name: string): Promise<{ status: number; problem: { type: string; detail: string; recovery?: string } }> => {
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse(`${fence}\nsleep 0\n\`\`\`\`\n\n\`\`\`\`WAIT\nObserve the refusal.\n\`\`\`\``, 10),
        makeRawMockResponse("````SEND [200]\nRefused; done.\n````", 10),
    ] });
    let row: { status: number; problem: { type: string; detail: string; recovery?: string } } | undefined;
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            await runLoopToTerminal(client, 2, { prompt: "Run it.", sessionId });
            const rows = await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: sessionId });
            const refused = rows.find(({ op, origin }) => op === "sh" && origin === "model");
            assert.ok(refused, `the refused execution is a row: ${JSON.stringify(rows.map(({ op, status_rx }) => [op, status_rx]))}`);
            row = { status: refused.status_rx, problem: JSON.parse(refused.rx).problem };
        } finally { client.close(); }
    });
    assert.ok(row);
    return row;
};

test("{§exec-lifetime} {§diagnostic-observation}: a scope on an execution is refused, saying only that", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal("````sh <30,5>", "exec-scope");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/scope-unsupported$/u);
    assert.equal(problem.detail, "An execution takes no scope.");
    assert.equal(problem.recovery, undefined);
});

test("{§exec-lifetime}: an unreadable lifetime is refused before the spawn, with every form it could take", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal('````sh [{"lifetime": "30"}]', "exec-lifetime-invalid");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/lifetime-invalid$/u);
    assert.match(problem.detail, /'30' is not a lifetime/u);
    assert.match(problem.recovery ?? "", /"30s", "30m", "2h".*"loop", "turn", or "detached"/u);
});

test("{§exec-lifetime}: a tool's opaque metadata is still its own — the service reads no lifetime from it", { timeout: 120_000 }, async () => {
    // {§executor-metadata} — `sh` takes the option-array shape, so a block that is not that shape is
    // the tool's to refuse. The service must not refuse it first in the name of `lifetime`.
    const { status, problem } = await refusal("````sh [ custom syntax ]", "exec-lifetime-opaque");
    assert.equal(status, 400);
    assert.match(problem.type, /executor\/metadata\/metadata-invalid$/u, "the executor's own refusal, not the service's");
    assert.doesNotMatch(problem.detail, /lifetime/u);
});

test("{§exec-lifetime}: a turn-scoped run is reaped at the next pre-turn; a loop-bound one at the loop's end", { timeout: 120_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse('````sh [{"lifetime": "turn"}]\nsleep 45\n````\n\n````NOTE\nBackgrounded for this turn only.\n````', 10),
        makeRawMockResponse("````NOTE\nThe next turn begins; the turn-scoped run is gone.\n````", 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name: "exec-lifetime-turn" });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            const { finalStatus } = await runLoopToTerminal(client, 2, { prompt: "Background it.", sessionId });
            assert.equal(finalStatus, 200, "the loop concluded without waiting on a stream it no longer holds");
            const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
            assert.equal(open?.n, 0, "the turn-scoped stream did not survive into the subsequent turn");
        } finally { client.close(); }
    });
});

// {§exec-lifetime} {§notifications-loop-terminated} A loop-bound run ends with its loop, whichever segment of the loop
// spawned it: reaped at the loop's terminal, its stream concluded before that terminal is announced.
for (const spawnedBy of ["the ending segment", "a segment before a park"] as const) {
    test(`{§exec-lifetime}: a loop-bound run spawned by ${spawnedBy} is reaped at its loop's terminal`, { timeout: 120_000 }, async (t) => {
        serverProposals(t, "accept");
        const window = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
        t.after(() => {
            if (window === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = window;
        });
        const parks = spawnedBy === "a segment before a park";
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(`\`\`\`\`sh\nsleep 45\n\`\`\`\`\n\n${parks ? "````WAIT [1]\nWaiting on it.\n````" : "````NOTE\nWorking on.\n````"}`, 10),
            makeRawMockResponse("````NOTE\nWorking on.\n````", 10),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `exec-lifetime-${parks ? "parked" : "ending"}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            const order: string[] = [];
            const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                const event = params as { scheme?: string; loopId?: number; result?: { status: number } };
                if (method === "stream/concluded" && event.scheme === "sh") order.push(`concluded ${event.result?.status}`);
                if (method === "loop/terminated") order.push(`terminated ${event.loopId} ${event.result?.status}`);
            });
            try {
                // The turn ceiling ends the loop in the segment after its spawn, or after the park, while the run still runs.
                const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Background it.", maxTurns: parks ? 2 : 1 });
                await waitForDb(async () => order, (events) => events.some((event) => event.startsWith("terminated")), { timeoutMs: 60_000 });
                assert.deepEqual(order, ["concluded 499", `terminated ${loopId} 429`], "the run is reaped before its loop's terminal is announced");
                const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
                assert.equal(open?.n, 0, "no stream outlives its loop");
            } finally {
                off();
            }
        });
    });
}
});

describe("exec-timeout", () => {
// {§exec-lifetime} — a bounded `[{"lifetime": …}]` caps the spawn. At the deadline the service
// aborts it (bounded reap) and stamps the stream 504, distinct from a deliberate kill (499).
// Own file: real subprocess + timing, process-isolated.







test("{§exec-lifetime} a bounded lifetime kills the spawn at its deadline and closes the stream 504", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // `sleep 30` under a 2-second lifetime: the spawn MUST be killed at its deadline, never run to completion.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        // Park on the stream: its only conclusion is the reap, so turn 2 sees the 504 close.
        makeMockResponse("````sh [{\"lifetime\": \"2s\"}]\nsleep 30\n````\n\n````WAIT\nwaiting for the reap\n````", 10),
        makeMockResponse("````SEND [200]\nthe spawn timed out; done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go" }, { timeoutMs: 45_000 });
            const elapsed = Date.now() - t0;
            // The proof: the deadline is never early, and a working lifetime ends the loop far short of the 30s the sleep
            // would take — a correctness check about the contract's own time, not a race.
            assert.ok(elapsed >= 2_000 && elapsed < 25_000, `the spawn was reaped at its 2s deadline, not run to 30s; elapsed=${elapsed}ms`);
            const closes = await waitFor(
                () => concluded() as Array<{ scheme: string; result: { status: number; problem?: { type: string } } }>,
                (events) => events.some(({ scheme }) => scheme === "sh"),
            );
            assert.ok(
                closes.some((c) => c.result.status === 504
                    && c.result.problem?.type === "https://problems.plurnk.xyz/scheme/exec/execution-timeout"),
                `the exec stream closed with the exact lifetime Problem; got ${JSON.stringify(closes.map((c) => c.result))}`,
            );
        } finally { ws.close(); }
    });
});
});

describe("exec-tool-fall-through", () => {
// {§exec-target-routing} — a bare shell command whose program is the name of an enabled
// runtime's tool dies with the shell's exit 127; the failure receipt says so at the failure site
// and names the invocation the registry actually publishes, so recovery takes one turn.









test("{§exec-target-routing} {§diagnostic-observation} a bare execution of a tool's name fails with a receipt that names the tool and its document", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nfail {\"message\":\"boom\"}\n````\n\n````WAIT\nwaiting on the shell\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tool-fall-through-${crypto.randomUUID()}` });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "try the tool by name" }, { timeoutMs: 30_000 });
            assert.equal(finalStatus, 200);
            // {§exec-stream}: the spawn's execution row is `started`; the process's conclusion is the receipt
            // on the stream's terminal READ — one per channel with content, and the shell's complaint is on stderr alone.
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const receipts = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(receipts.length, 1, "one terminal READ, on the channel that holds the shell's complaint");
            assert.deepEqual((JSON.parse(receipts[0].rx) as { channels?: unknown }).channels, { "#stdout": 0 }, "the empty stdout is a fact on that receipt");
            assert.equal(receipts[0].status_rx, 404, "the named program did not run");
            const receipt = JSON.parse(receipts[0].rx) as { exitCode?: number; problem?: { type?: string; detail?: string; recovery?: string; toolRuntimes?: string[]; tool?: string } };
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/exec/program-is-a-tool");
            assert.equal(receipt.problem?.detail, "'sh' exited with code 127; `fail` is a registered tool of `fixture`."); // {§pinned-wording-core}
            assert.equal(
                receipt.problem?.recovery,
                "`fail`'s contract: workspace:///_plurnk/tools/fixture/fail.json.",
            );
            assert.deepEqual(receipt.problem?.toolRuntimes, ["fixture"]);
            assert.equal(receipt.problem?.tool, "fail");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§exec-target-routing} a program the registry does not know keeps the shell's own answer", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nno_such_program_zq --help\n````\n\n````WAIT\nwaiting\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `plain-127-${crypto.randomUUID()}` });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "run nothing" }, { timeoutMs: 30_000 });
            const terminal = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId }))
                .find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.ok(terminal);
            const receipt = JSON.parse(terminal.rx) as { exitCode?: number; problem?: unknown };
            assert.equal(terminal.status_rx, 200);
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem, undefined, "no tool is invented for a program the registry does not know");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("execs-batteries", () => {
// Batteries-included executor coverage — every executor the service-owned
// default executor extensions ship, driven end-to-end through the REAL Exec
// scheme (dispatch → run/accept → spawn → read
// the captured output channel), not sh alone.
//
// Two axes: each runtime's output lands on its OWN
// declared channel (subprocess -> stdout), and host-effecting
// runtimes PROPOSE (accept) while pure/read ones are automatically accepted. The census requires
// every available self-contained tag to be covered and fails when a default tag is undiscovered
// ({§exec-target-routing}).












// The host sets FORCE_COLOR; ANSI control bytes are the subject of this sanitizer.
// oxlint-disable-next-line eslint/no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// {§exec-executor-slot} — the battery's third column is the program path, never a cwd.
const execStmt = (runtime: string, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: target === null ? null : localPath(target),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Drive one executor through the full Exec path and return its captured, ANSI-stripped output —
// from the executor's OWN default channel (subprocess runtimes → stdout) —
// plus the one effect fact that drove automatic admission or proposal review.
const runExec = async (tag: string, body: string, cwd: string | null): Promise<{ status: number; out: string; effect: Effect; mimetype: string; declaredMimetype: string | undefined }> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        const entry = registry.entry(tag);
        assert.ok(entry?.available, `the ${tag} executor is available`);
        const channel = entry.executor.defaultChannel;
        const declaredMimetype = entry.executor.channels[channel]?.mimetype;
        const workspaceId = await insertWorkspace(db, `batt-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "batteries");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(tag, cwd, body),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Side-effecting (host) executors propose; pure/read ones are automatically
        // accepted within dispatch. The persisted effect is the deterministic fact —
        // a row-state check races automatic settlement. Accept only a host proposal.
        const proposal = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const effect = (JSON.parse(proposal?.attrs ?? "{}") as { effect: Effect }).effect;
        assert.ok(effect === "pure" || effect === "read" || effect === "host", "execution persists its canonical effect fact");
        if (effect === "host") engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        await exec.idle(); // the spawn runs async; idle() awaits its close

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: tag, pathname });
        // idle() awaits the spawn promise, which drains the channel-write queue before resolving, so the
        // output is committed by here — for auto-accepted and proposed runtimes alike. No poll, no close-race.
        const out = entryRow
            ? await db.test_get_channel.get<{ content: string; state: string; mimetype: string }>({ entry_id: entryRow.id, name: channel })
            : undefined;
        assert.equal(out?.state, "closed", `${tag} output channel settled to closed by idle()`);
        return { status: result.status, out: stripAnsi(out?.content ?? ""), effect, mimetype: out?.mimetype ?? "", declaredMimetype };
    } finally {
        await db.close();
    }
};


// One deterministic specimen per bundled runtime. `gate` verifies its
// executor-owned effect fact through core admission. {§executor-effect}
const CASES: ReadonlyArray<{ tag: string; body: string; cwd: string | null; expect: string; gate: "propose" | "auto" }> = [
    // Subprocess runtimes execute arbitrary host code → ALWAYS `host` → always gated, even for a
    // visibly-harmless command (the executor classifies the target, never parses the command to judge it).
    { tag: "python3", body: "print(sum(range(101)))", cwd: null, expect: "5050\n", gate: "propose" },
    { tag: "js", body: "console.log(6 * 7)", cwd: null, expect: "42\n", gate: "propose" },
];

// Self-contained batteries tags — runnable deterministically with no external resource. The census
// REQUIRES every one of these that the host probes available to be covered by this suite (sh is
// covered by Exec.scheme.test.ts).
const SELF_CONTAINED = ["sh", "js", "python3"] as const;

test("{§exec-target-routing} execs batteries: coverage census — every self-contained default-install tag is exercised", async () => {
    const reg = await testExecutors();
    const available = new Set(reg.availableRuntimes());
    const covered = new Set(CASES.map((c) => c.tag).concat("sh")); // sh: Exec.scheme.test.ts
    // {§exec-target-routing}: the registry retains probe-failed entries as unavailable; a missing
    // entry means the default composition deleted or renamed a package, not that this host lacks it.
    const undiscovered = SELF_CONTAINED.filter((t) => reg.entry(t) === undefined);
    assert.deepEqual(undiscovered, [], `census tags missing from the bundle entirely (deleted/renamed package?): ${undiscovered.join(", ")}`);
    const exercised = SELF_CONTAINED.filter((t) => available.has(t) && covered.has(t));
    const unavailable = SELF_CONTAINED.filter((t) => !available.has(t));
    const uncovered = SELF_CONTAINED.filter((t) => available.has(t) && !covered.has(t));
    console.log(`  self-contained, exercised: ${exercised.join(", ")}`);
    console.log(`  unavailable in this env: ${unavailable.join(", ") || "(none)"}`);
    assert.deepEqual(uncovered, [], `every AVAILABLE self-contained batteries tag must be covered — uncovered: ${uncovered.join(", ")}`);

    // Subprocess runtimes declare text/stream on stdout.
    const declMime = (tag: string): string | undefined => {
        const e = reg.entry(tag);
        return e?.executor?.channels[e.executor.defaultChannel]?.mimetype;
    };
    for (const t of ["js", "python3"]) assert.equal(declMime(t), "text/stream", `${t} stdout channel is text/stream`);
});

for (const { tag, body, cwd, expect, gate } of CASES) {
    const label = `${tag}${cwd === null ? "" : ` (${gate} target)`}`;
    test(`{§executor-consumer-boundary} execs batteries: ${label} runs through the real Exec scheme, captures output, gates per effect`, async (t) => {
        const reg = await testExecutors();
        if (!reg.availableRuntimes().includes(tag)) {
            t.skip(`${tag} not available in this env (probe failed / resource-gated)`);
            return;
        }
        const { status, out, effect, mimetype, declaredMimetype } = await runExec(tag, body, cwd);
        assert.equal(status, 200, `${label} dispatch returns 200`);
        assert.equal(out, expect, `${label} output`);
        // The stream entry's channel carries the executor's OWN declared mimetype.
        // The Exec seed honors the declaration; the write never overwrites it.
        assert.equal(mimetype, declaredMimetype, `${label} channel carries the executor's declared mimetype`);
        // The security boundary: effect→gate must match. A host runtime MUST propose (be review-gated);
        // a pure/read one MUST auto-run. A regression that automatically admits
        // a host runtime would let arbitrary host code run ungated.
        assert.equal(effect === "host" ? "propose" : "auto", gate, `${label} effect drives the expected proposal policy`);
    });
}

test("{§exec-executor-slot} an unregistered executable tag fails without shell reinterpretation", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        assert.ok(!registry.availableRuntimes().includes("echo"), "precondition: echo is NOT a registered runtime");
        const workspaceId = await insertWorkspace(db, `batt-ft-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "ft");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: execStmt("echo", null, "hello fallthrough"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        // {§exec-executor-slot} — an unregistered executor name is refused as such, never reinterpreted
        // as a shell command word; the refusal lists what is registered.
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
        assert.equal(result.problem?.requestedRuntime, "echo");
        assert.deepEqual(result.problem?.executors, registry.availableRuntimes(), "the refusal lists the registered executors");
        assert.equal(result.problem?.toolRuntimes, undefined, "an arbitrary unknown word names no tool runtime");
        const shell = await engine.dispatch({
            statement: execStmt("shell", null, "printf hello"),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(shell.status, 400);
        assert.equal(shell.problem?.requestedRuntime, "shell", "an unknown alias does not trigger an intent-presuming correction");
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: "/1/1/1/sh" });
        assert.equal(entryRow, undefined, "an unknown tag never spawns or creates a shell stream");
    } finally { await db.close(); }
});
});

describe("mcp-env-composition", () => {
const fixture = fileURLToPath(new URL("./fixtures/environment-mcp.mjs", import.meta.url));
// A stdio definition for the environment fixture, which records each launch's environment in its marker.
const environmentEntry = (env: Readonly<Record<string, string>>): object => ({ type: "stdio", command: "node", args: [fixture], env: { ...env } });
type Start = { witness: string | null; private: string | null; bound: string | null; catalog: string | null; plurnk: string | null; reference: string | null; home: string | null; pid: number };

// {§mcp-launch-environment} — the operator's environment is the daemon process's own, so the test sets it there.
const withOperatorEnvironment = (t: TestContext, values: Readonly<Record<string, string>>): void => {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    Object.assign(process.env, values);
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
};

test("{§functionality-model-mutation} MCP replacement precedes a tool invocation in the same raw model program", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, { fixture: environmentEntry({ ENV_WITNESS: "original" }) });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeRawMockResponse([
            PlurnkParser.frame("plurnk (mcp)", JSON.stringify({ verb: "replace", alias: "fixture", definition: { name: "fixture", ...environmentEntry({ ENV_WITNESS: "replacement" }) } })),
            PlurnkParser.frame("fixture (environment)", "{}"),
            PlurnkParser.frame("NOTE", "Observe the new server's reply."),
        ].join("\n\n")),
        makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-ordered" });
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Replace the server and query its environment.", maxTurns: 2 });
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
    const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "plurnk")?.status_rx, 201, "replacement creates the workspace override before invoking its tool");
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "fixture")?.status_rx, 200);
    const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body" });
    assert.equal(output.witness, "replacement", "the tool runs on the new attachment, not the old server");
    assert.equal(await lifecycle.status(loop.loopId), 200);
});

test("{§mcp-launch-environment} a configured stdio server starts with the operator's environment beneath the workspace layer, never a session's, and picks up changes only on restart", { timeout: 30000 }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-env-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    withOperatorEnvironment(t, {
        // Outside the model's command ceiling ({§execution-output-identity}), which is not an MCP server's base.
        REF_VALUE: "operator",
        // {§execution-output-identity} A declared provider credential is excluded from ambient inheritance.
        BOUND_VALUE: "operator-credential",
        PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
    });
    const marker = (server: string) => join(scratch, `${server}.jsonl`);
    const explicitEnv = { MCP_ENV_MARKER: marker("explicit"), ENV_WITNESS: "explicit" };
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        fixture: environmentEntry({ MCP_ENV_MARKER: marker("fixture") }),
        explicit: environmentEntry(explicitEnv),
    });
    const db = await openMigrated();
    const boot = () => {
        const instance = new Daemon({ db, provider: null, schemes: new SchemeRegistry(), hostPaths });
        instance.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
        return instance;
    };
    let daemon = boot();
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-env-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, sessionId);
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        const set = (alias: string, value: string) => invoke("env", "add", { alias, definition: { value } });
        const starts = async (server: string): Promise<Start[]> => (await readFile(marker(server), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
        // The first action that needs the workspace activates it, launching its enabled servers.
        await set("ENV_WITNESS", "workspace");
        const launched = (await starts("fixture")).at(-1);
        assert.equal(launched?.reference, "operator", "an operator variable outside the model's command ceiling reaches the server");
        assert.equal(launched?.bound, null, "a provider credential is not inherited implicitly");
        assert.equal(launched?.plurnk, null, "nor does any of plurnk's own settings");
        assert.equal(launched?.home, hostPaths.home);
        assert.equal(launched?.witness, null, "the server launched before the workspace defined its value");
        await daemon.invokeModuleAction("session.env.add", { alias: "ENV_WITNESS", definition: { value: "private" } }, { scope: "session", workspaceId, sessionId });
        await daemon.invokeModuleAction("session.env.add", { alias: "SESSION_ONLY", definition: { value: "private" } }, { scope: "session", workspaceId, sessionId });
        const before = await starts("fixture");
        await invoke("mcp", "list");
        assert.deepEqual(await starts("fixture"), before, "env edits and listing do not restart a live MCP");
        await invoke("mcp", "disable", { alias: "fixture" });
        await invoke("mcp", "enable", { alias: "fixture" });
        assert.equal((await starts("fixture")).at(-1)?.witness, "workspace", "the workspace layer applies on top of the operator's environment");
        assert.equal((await starts("fixture")).at(-1)?.private, null);
        assert.notEqual((await starts("fixture")).at(-1)?.pid, before.at(-1)?.pid);

        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        const run = async (runtime: string, heading: string, body: object, approve: boolean, status: number, channel = "results") => {
            const source = PlurnkParser.frame(heading, JSON.stringify(body));
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            const op = parsed.items[0];
            assert.equal(op?.kind, "statement");
            if (op?.kind !== "statement") throw new Error("Expected one operation");
            const after = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: runtime, prefix: "/%" })).length;
            const seen = proposals.length;
            // The session's own verb, reviewed by its owner.
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: op.statement });
            if (approve) {
                await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10000 });
                await daemon.resolveProposal(proposals[seen], { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            }
            assert.equal((await pending).status, status);
            return awaitExecOutcome(db, { workspaceId, scheme: runtime, after, channel, timeoutMs: 10000 });
        };
        try {
            const changed = await run("plurnk", "plurnk (env)", { verb: "add", scope: "workspace", alias: "REF_VALUE", definition: { value: "workspace-reference" } }, true, 201);
            assert.equal((changed.definition as { origin: string }).origin, "workspace", "the accepted model verb uses the same workspace layer as client actions");
            await invoke("mcp", "disable", { alias: "explicit" });
            await invoke("mcp", "enable", { alias: "explicit" });
            const received = await run("explicit", "explicit (environment)", {}, true, 200, "body");
            assert.equal(received.witness, "explicit", "the entry's env applies over the workspace layer");
            assert.equal(received.reference, "workspace-reference", "a workspace value replaces the operator's");
            assert.equal(received.private, null, "the invoking session never becomes the shared MCP's environment");

            const listed = await invoke("mcp", "list") as FunctionalityListResult;
            const retained = listed.definitions.find(({ alias }) => alias === "explicit");
            assert.ok(retained);
            assert.deepEqual((retained.definition as { env: object }).env, explicitEnv, "the definition stays symbolic; no resolved or ambient value is copied into it");
        } finally { unsubscribe(); }

        await invoke("env", "disable", { alias: "HOME" });
        const beforeCold = { fixture: (await starts("fixture")).length, explicit: (await starts("explicit")).length };
        await daemon.stop();
        daemon = boot();
        await daemon.start();
        const coldList = await invoke("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(coldList.definitions.map(({ alias, state }) => [alias, state]), [["explicit", "dormant"], ["fixture", "dormant"]]);
        assert.deepEqual({ fixture: (await starts("fixture")).length, explicit: (await starts("explicit")).length }, beforeCold, "cold inspection starts no servers");
        await invoke("mcp", "enable", { alias: "fixture" });
        const rehydrated = [...(await starts("fixture")).slice(beforeCold.fixture), ...(await starts("explicit")).slice(beforeCold.explicit)];
        const activeList = await invoke("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(activeList.definitions.map(({ alias, state }) => [alias, state]), [["explicit", "active"], ["fixture", "active"]]);
        assert.deepEqual(new Set(rehydrated.map(({ witness }) => witness)), new Set(["workspace", "explicit"]), "cold activation reconstructs the workspace layer beneath each entry's env");
        for (const received of rehydrated) {
            assert.equal(received.reference, "workspace-reference");
            assert.equal(received.private, null);
            assert.equal(received.bound, null);
            assert.equal(received.home, null, "a workspace withholding removes an operator name, and the SDK's default environment cannot reintroduce it");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mcp-launch-environment} native definitions bind credentials explicitly, retain references, and refuse missing references before launch", { timeout: 30000 }, async (t) => {
    const credentials = {
        BOUND_VALUE: "synthetic-custom-provider-credential",
        OPENAI_API_KEY: "synthetic-catalog-provider-credential",
        PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
    };
    withOperatorEnvironment(t, credentials);
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-bindings-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const cases: { alias: string; env: Record<string, string>; bound: string | null; catalog: string | null }[] = [
        { alias: "ambient", env: {}, bound: null, catalog: null },
        { alias: "referenced", env: { BOUND_VALUE: "${BOUND_VALUE}", OPENAI_API_KEY: "${OPENAI_API_KEY}" }, bound: credentials.BOUND_VALUE, catalog: credentials.OPENAI_API_KEY },
        { alias: "literal", env: { BOUND_VALUE: "explicit-custom", OPENAI_API_KEY: "explicit-catalog" }, bound: "explicit-custom", catalog: "explicit-catalog" },
    ];
    const marker = (alias: string) => join(scratch, `${alias}.jsonl`);
    const definitions = Object.fromEntries(cases.map(({ alias, env }) => [alias, environmentEntry({ ...env, MCP_ENV_MARKER: marker(alias) })]));
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, definitions);
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...credentials } }), "@plurnk/plurnk-mcp");
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-bindings-${crypto.randomUUID()}`);
        const invoke = (verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
        await invoke("enable", { alias: "ambient" });
        const list = await invoke("list") as FunctionalityListResult;
        for (const { alias, env, bound, catalog } of cases) {
            const starts = (await readFile(marker(alias), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
            assert.ok(starts.length > 0, `${alias} launched a server`);
            for (const started of starts) {
                assert.deepEqual({ bound: started.bound, catalog: started.catalog, plurnk: started.plurnk }, { bound, catalog, plurnk: null }, alias);
            }
            const retained = list.definitions.find((item) => item.alias === alias);
            assert.ok(retained);
            assert.equal(retained.state, "active");
            assert.deepEqual((retained.definition as { env: object }).env, { ...env, MCP_ENV_MARKER: marker(alias) });
        }
        for (const credential of [credentials.BOUND_VALUE, credentials.OPENAI_API_KEY]) {
            assert.equal(JSON.stringify(list).includes(credential), false, "resolution never copies a host credential into its definition");
        }

        await assert.rejects(invoke("add", { alias: "missing", definition: { name: "missing", ...environmentEntry({
            MCP_ENV_MARKER: marker("missing"), BOUND_VALUE: "${ABSENT_CREDENTIAL}",
        }) } }), (cause: unknown) => {
            assert.ok(cause instanceof Error && "problem" in cause);
            const problem = Validator.assertProblemDetails(cause.problem);
            assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
            assert.equal(problem.status, 502);
            assert.ok(cause.cause instanceof Error);
            assert.match(cause.cause.message, /missing environment variable ABSENT_CREDENTIAL/u);
            return true;
        });
        await assert.rejects(readFile(marker("missing")), { code: "ENOENT" });
        assert.deepEqual((await invoke("list") as FunctionalityListResult).definitions, list.definitions, "failed preparation preserves the published definitions");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const { policy, decision } of [
    { policy: "review", decision: "accept" },
    { policy: "review", decision: "reject" },
    { policy: "accept", decision: "accept" },
    { policy: "reject", decision: "reject" },
] as const) {
    test(`{§mcp-launch-environment} a model-added credential binding follows ordinary ${policy}/${decision} approval`, { timeout: 30000 }, async (t) => {
        serverProposals(t, policy);
        const credential = "synthetic-approved-provider-credential";
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, {});
        const marker = join(hostPaths.home, "launched.jsonl");
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider: null, hostPaths });
        daemon.registerModule(McpModule.init({ env: {
            ...mcpEnv, BOUND_VALUE: credential,
            PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
        } }), "@plurnk/plurnk-mcp");
        await daemon.start();
        try {
            const workspaceId = await insertWorkspace(db, `mcp-approval-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, "alice", "model");
            await ownSession(db, workspaceId, sessionId);
            const list = () => daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as Promise<FunctionalityListResult>;
            const definition = { name: "credential", ...environmentEntry({ MCP_ENV_MARKER: marker, BOUND_VALUE: "${BOUND_VALUE}" }) };
            const source = PlurnkParser.frame("plurnk (mcp)", JSON.stringify({ verb: "add", alias: "credential", definition }));
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            const op = parsed.items[0];
            assert.ok(op?.kind === "statement");
            const proposals: number[] = [];
            const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
                if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
            });
            t.after(unsubscribe);
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: op.statement });
            if (policy === "review") {
                await waitFor(() => proposals, (items) => items.length === 1, { timeoutMs: 10000 });
                assert.deepEqual((await list()).definitions, [], "awaiting approval publishes no definition");
                await assert.rejects(readFile(marker), { code: "ENOENT" }, "awaiting approval launches no process");
                await daemon.resolveProposal(proposals[0], { decision }, { workspaceId, address: TEST_OWNER });
            }
            const result = await pending;
            if (decision === "reject") {
                assert.equal(result.status, 400);
                const problem = Validator.assertProblemDetails(result.problem);
                assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/rejected");
                assert.deepEqual((await list()).definitions, []);
                await assert.rejects(readFile(marker), { code: "ENOENT" }, "a rejected launch never starts the server");
                return;
            }
            assert.equal(result.status, 201);
            const added = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", timeoutMs: 10000 });
            assert.equal((added.definition as { state: string }).state, "active");
            const starts = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
            assert.ok(starts.length > 0);
            assert.ok(starts.every(({ bound }) => bound === credential), "the approved server receives the named credential");
            const retained = await list();
            assert.deepEqual(retained.definitions[0]?.definition, definition);
            assert.equal(JSON.stringify(retained).includes(credential), false, "only the symbolic binding is saved");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
}

test("{§mcp-launch-environment} {§mcp-server-settings} a bearer setting resolves against the operator environment beneath the workspace layer and never enters the definition", async (t) => {
    const received: Array<string | null> = [];
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "authorized", version: "1.0.0" });
        server.registerTool("ready", { inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }) }, async () => ({ content: [{ type: "text", text: "ready" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), (request) => {
        const authorization = request.headers.get("authorization");
        received.push(authorization);
        return authorization === "Bearer workspace-token" ? null : new Response("incorrect fixture authorization", { status: 401 });
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { authorized: {
        ...httpEntry(served.url), authorization: { type: "bearer", token: "${ENV_AUTH}" },
    } });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS, ENV_AUTH: "operator-token" } }), "@plurnk/plurnk-mcp");
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `http-env-${crypto.randomUUID()}`);
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        // Activation connects before the workspace defines ENV_AUTH, so the fixture refuses that attempt.
        await invoke("env", "add", { alias: "ENV_AUTH", definition: { value: "workspace-token" } });
        assert.deepEqual([...new Set(received)], ["Bearer operator-token"], "the reference resolves against the operator environment");
        const activated = received.length;
        const enabled = await invoke("mcp", "enable", { alias: "authorized" }) as { definition: { state: string } };
        assert.equal(enabled.definition.state, "active", "enabling the unavailable alias reconnects it");
        assert.deepEqual([...new Set(received.slice(activated))], ["Bearer workspace-token"], "the workspace layer applies on top of the operator environment");
        const list = await invoke("mcp", "list") as FunctionalityListResult;
        assert.doesNotMatch(JSON.stringify(list.definitions), /-token/u, "the definition holds no captured credential");
        await invoke("mcp", "disable", { alias: "authorized" });
        await invoke("env", "disable", { alias: "ENV_AUTH" });
        const before = received.length;
        await assert.rejects(invoke("mcp", "enable", { alias: "authorized" }), (error: unknown) => {
            assert.ok(error instanceof Error && "problem" in error);
            const problem = Validator.assertProblemDetails(error.problem);
            assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
            assert.equal(problem.status, 502);
            assert.ok(error.cause instanceof Error);
            assert.match(error.cause.message, /missing environment variable ENV_AUTH/u);
            return true;
        });
        assert.equal(received.length, before, "a workspace mask cannot fall back to the operator's reference value");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("mcp-resource-owners", () => {
let prevWarmMs: string | undefined;
let prevFilesItems: string | undefined;
beforeAll(() => {
    prevWarmMs = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    prevFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "0";
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
});
afterAll(() => {
    if (prevWarmMs === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = prevWarmMs;
    if (prevFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
    else process.env.PLURNK_SERVICE_FILES_ITEMS = prevFilesItems;
});
const uri = "fixture://resource/item";
const guardedUri = "fixture://resource/guarded";
const multipartUri = "fixture://resource/multipart";
const path = resourcePath(uri);
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");

const statement = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    assert.equal(parsed.unparsedTail, undefined);
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    if (item?.kind !== "statement") throw new Error("Expected one operation");
    return item.statement;
};

const fixture = async (t: TestContext, responses: string[] = []) => {
    const reads: string[] = [];
    const paused = new Map<string, { entered: () => void; released: Promise<void> }>();
    const servers = await Promise.all(["alice", "bob"].map(async (name) => {
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name, version: "1.0.0" });
            server.registerTool("snapshot", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => ({ content: [{ type: "resource", resource: {
                uri: "fixture://data/snapshot.txt", mimeType: "text/plain", text: `${name}'s saved result`,
            } }] }));
            server.registerResource("item", uri, { mimeType: "text/plain" }, async () => {
                reads.push(name);
                const pause = paused.get(name);
                pause?.entered();
                await pause?.released;
                return { contents: [{ uri, mimeType: "text/plain", text: `${name}'s resource` }] };
            });
            server.registerResource("multipart", multipartUri, { mimeType: "text/plain" }, async () => ({ contents: [
                { uri: "fixture://part/first.txt", mimeType: "text/plain", text: `${name}:first` },
                { uri: "fixture://part/last.txt", mimeType: "text/plain", text: `${name}:last` },
            ] }));
            server.registerResource("guarded", guardedUri, { mimeType: "text/plain" }, async (_uri, ctx) => {
                const answer = inputResponse(ctx.mcpReq.inputResponses, "read");
                if (answer.kind === "missing") return inputRequired({ inputRequests: {
                    read: inputRequired.elicit({
                        message: `Read ${name}'s resource?`,
                        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false },
                    }),
                } });
                return { contents: [{ uri: guardedUri, mimeType: "text/plain", text: `${name}:${answer.kind === "elicit" ? answer.action : answer.kind}` }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        return { name, ...served };
    }));
    // {§mcp-configuration}
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, Object.fromEntries(servers.map(({ name, url }) => [name === "alice" ? "shared" : "other", httpEntry(url)])));
    const environment: Record<string, string> = { ...mcpEnv, PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000" };
    const db = await openMigrated();
    let schemes = new SchemeRegistry();
    const provider = new Mock({ contextWindow: 1_000_000, responses: responses.map(makeMockResponse) });
    const createDaemon = () => {
        const instance = new Daemon({ db, schemes, provider, nodeModulesPath: resolvePath("node_modules"), hostPaths });
        instance.registerModule(McpModule.init({ env: environment }), "@plurnk/plurnk-mcp");
        return instance;
    };
    let daemon = createDaemon();
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-owners" });
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    await ownSession(db, workspaceId, alice);
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    const action = (operation: string, params: Record<string, unknown>) => daemon.invokeModuleAction(
        `workspace.mcp.${operation}`, params, { scope: "workspace", workspaceId },
    );
    const cool = () => waitForDb(async () => !schemes.has("shared", workspaceId) && !schemes.has("other", workspaceId), Boolean);
    await cool();
    // {§functionality-hotload}
    const reinstall = async (entries: Readonly<Record<string, object>>) => {
        for (const key of Object.keys(environment)) {
            if (/^PLURNK_MCP_[a-z]/u.test(key)) delete environment[key];
        }
        Object.assign(environment, mcpEnvironment(entries));
        await cool();
    };
    // A person's READ ({§connection-lifecycle}): no reader attaches the addressed runtime itself.
    const read = async (target: string) => (await daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, statements: [statement(PlurnkParser.frame(`READ (${target}) <1,-1>`, null))],
    }))[0];
    const setPolicy = (policy: CapabilityPolicy) => waitForDb(async () => {
        try {
            await daemon.setWorkspaceCapabilities({ workspaceId, policy });
            return true;
        } catch (error) {
            // Zero-grace cooling shares the mutation gate; only its documented busy refusal is retryable.
            if (!(error instanceof OperationFailureError)
                || error.result.problem.type !== "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy") throw error;
            assert.equal(error.result.status, 409);
            assert.equal(error.result.problem.retryable, true);
            return false;
        }
    }, Boolean);
    const restart = async () => {
        await daemon.stop();
        schemes = new SchemeRegistry();
        daemon = createDaemon();
        await daemon.start();
    };
    return { db, get daemon() { return daemon; }, provider, get schemes() { return schemes; }, servers, restart, workspaceId, alice, bob, read, reads, paused, action, cool, reinstall, setPolicy };
};

test("{§execution-output-identity}: shared cold MCP resources, catalog links, caller policy, and concurrent connection leases", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    assert.equal(f.provider.received.length, 0, "attaching and cooling never invokes a model");
    const foreign = await f.read(`shared://${path}`);
    assert.equal(foreign.content, "alice's resource", JSON.stringify(foreign));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const ownCatalog = await f.read("shared:///resources");
    assert.equal(ownCatalog.status, 200, JSON.stringify(ownCatalog));
    const ownResource = (JSON.parse(String(ownCatalog.content)) as { resources: Array<{ uri: string; address: string }> }).resources.find((resource) => resource.uri === uri)!;
    const followed = await f.read(ownResource.address);
    assert.equal(followed.content, "alice's resource", JSON.stringify({ address: ownResource.address, ...followed }));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource", "a reader need not attach the addressed runtime itself");
    assert.equal((await f.read(`shared://missing${path}`)).status, 404);
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const catalog = await f.read("shared:///resources");
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    const listed = JSON.parse(String(catalog.content)) as { resources: Array<{ uri: string; address: string }> };
    const linked = listed.resources.find((resource) => resource.uri === uri);
    assert.equal(linked?.address, `shared://${path}`);
    assert.equal((await f.read(linked.address)).content, "alice's resource");
    const multi = await f.read(`shared://${resourcePath(multipartUri)}`);
    const parts = [...String(multi.content).matchAll(/<(shared:\/\/\/[^>]+)>/gu)].map((match) => match[1]);
    assert.equal(parts.length, 2, JSON.stringify(multi));
    assert.equal((await f.read(parts[0])).content, "alice:first");

    await f.setPolicy({ deny: [{ access: "observe", scheme: "shared" }] });
    const before = f.reads.length;
    const denied = await f.read(`shared://${path}`);
    assert.equal(denied.status, 403, JSON.stringify(denied));
    assert.match(JSON.stringify(denied.problem), /capability-denied/);
    assert.equal(f.reads.length, before, "denied observation never calls resources/read");
    await f.setPolicy({});
    await f.cool();

    const aliceEntered = Promise.withResolvers<void>();
    const bobEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.paused.set("alice", { entered: aliceEntered.resolve, released: release.promise });
    f.paused.set("bob", { entered: bobEntered.resolve, released: release.promise });
    const pending = Promise.all([
        f.read(`shared://${path}`),
        f.read(`other://${path}`),
    ]);
    try {
        await Promise.all([aliceEntered.promise, bobEntered.promise]);
        assert.equal(f.schemes.has("shared", f.workspaceId), true);
        assert.equal(f.schemes.has("other", f.workspaceId), true);
        await assert.rejects(() => f.action("disable", { alias: "other" }), (error) => {
            assert.ok(error instanceof OperationFailureError);
            const { problem } = error.result;
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
            assert.equal(problem.workspaceId, f.workspaceId);
            return true;
        });
    } finally { release.resolve(); }
    const [aliceResult, bobResult] = await pending;
    assert.equal(aliceResult.content, "alice's resource");
    assert.equal(bobResult.content, "bob's resource");
    await f.cool();
    assert.equal(f.provider.received.length, 0, "cold and concurrent resource access never runs any model");
});

for (const transition of ["enabled", "disabled", "removed", "producer-removed", "replaced", "restarted"] as const) {
    test(`{§mcp-result-content}: a client can follow its saved result link with the attachment ${transition}`, { timeout: 20_000 }, async (t) => {
        const f = await fixture(t);
        const [invoked] = await f.daemon.dispatchClientAction({
            workspaceId: f.workspaceId, actor: TEST_OWNER, statements: [statement(PlurnkParser.frame("shared (snapshot)", "{}"))],
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        // The person's operation produced the result in the workspace's runtime session ({§connection-lifecycle}).
        const producer = await f.daemon.ensureRuntimeSession(f.workspaceId);
        const published = await waitForDb(async () => {
            const entries = await f.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({
                workspace_id: f.workspaceId, scheme: "shared", prefix: "%",
            });
            const output = entries.find(({ pathname }) => /^\/[a-f0-9]{8}$/u.test(pathname));
            return output === undefined ? undefined : f.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                pathname: output.pathname, scheme: "shared", name: "body",
            });
        }, (channel) => channel?.content.includes("/resources/snapshot.txt") === true);
        const address = /<(shared:\/\/[^>]+)>/u.exec(published!.content)?.[1];
        assert.ok(address, published!.content);
        const settled = await waitForDb(() => f.db.test_latest_subscription_for_session.get<{ close_status: number | null }>({
            session_id: producer,
        }), (subscription) => subscription?.close_status !== null && subscription?.close_status !== undefined);
        assert.equal(settled?.close_status, 200, "the saved result's producer settles successfully before lifecycle changes");
        if (transition === "disabled") {
            const changed = await f.action("disable", { alias: "shared" }) as { status: number };
            assert.equal(changed.status, 200, JSON.stringify(changed));
        }
        if (transition === "removed") {
            await f.reinstall({ other: httpEntry(f.servers[1].url) });
            const listed = await f.action("list", {}) as FunctionalityListResult;
            assert.deepEqual(listed.definitions.map(({ alias }) => alias), ["other"], "the baseline no longer declares shared");
        }
        if (transition === "replaced") {
            await f.reinstall({ shared: httpEntry(f.servers[1].url), other: httpEntry(f.servers[1].url) });
            assert.equal((await f.read(`shared://${path}`)).content, "bob's resource");
        }
        if (transition === "restarted") {
            assert.equal((await f.action("disable", { alias: "shared" }) as { status: number }).status, 200);
            await f.restart();
        }
        assert.match(address, /^shared:\/\/\/[a-f0-9]{8}\/resources\//u);
        if (transition === "producer-removed") await f.db.test_delete_session.run({ id: producer });
        const result = await f.read(address);
        assert.equal(result.status, 200, JSON.stringify({ address, transition, result }));
        assert.equal(result.content, "alice's saved result");
        const directory = address.slice(0, address.lastIndexOf("/") + 1);
        const [catalog] = await f.daemon.dispatchClientAction({
            workspaceId: f.workspaceId, actor: TEST_OWNER,
            statements: [statement(PlurnkParser.frame(`FIND (${directory})`, null))],
        });
        assert.equal(catalog.status, 200, JSON.stringify(catalog));
        assert.match(JSON.stringify(catalog), /snapshot\.txt/);
        assert.equal(f.provider.received.length, 0, "reading an artifact requires no model inference");
    });
}

test("{§execution-output-identity}: MCP resource elicitation and its receipt belong to the requesting model operation", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${step("NOTE")}`,
        PlurnkParser.frame("SEND [200]", "The resource was read."),
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, sessionId: f.alice, prompt: "Read Bob's guarded resource." });
    const waiting = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    const interaction = waiting[0];
    assert.equal(interaction.sessionId, f.alice);
    assert.equal(interaction.loopId, run.loopId);
    assert.match(JSON.stringify(interaction), /Read bob's resource/);
    await f.daemon.resolveClientInteraction(interaction.interactionId, {
        action: "accept", content: { confirm: true },
    }, { workspaceId: f.workspaceId, address: TEST_OWNER });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200);
    assert.equal(f.provider.received.length, 2, "the owner model never starts");
    assert.match(f.provider.received[1].map(chatMessageText).join("\n"), /bob:accept/);
    const receipts = await f.db.test_log_entries_by_loop.all<{ op: string; status_rx: number; target: string }>({ loop_id: run.loopId });
    assert.ok(receipts.some((row) => row.op === "READ" && row.status_rx === 200), "the READ receipt stays in Alice's loop");
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
});

test("{§execution-output-identity}: cancelling the requester settles its MCP interaction and releases the shared connection", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${step("NOTE")}`,
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, sessionId: f.alice, prompt: "Read Bob's guarded resource." });
    const pending = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    assert.equal(pending[0].sessionId, f.alice);
    await f.daemon.cancelSession({ workspaceId: f.workspaceId, sessionId: f.alice, reason: "resource reader cancelled" });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 499);
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
    await f.cool();
    assert.equal(f.provider.received.length, 1, "neither the cancelled reader nor the resource owner's model continues");
    assert.equal((await f.read(`other://${path}`)).content, "bob's resource", "cancellation leaves the workspace attachment usable");
    await f.cool();
    assert.equal(f.provider.received.length, 1);
});
});

describe("module-runtime", () => {
// Module-owned runtimes register through one protocol-neutral seam. The engine
// adds the executor tag and its output scheme atomically while a resource facet
// may claim a distinct subtree under that same scheme.



















// Registration supplies output declarations without starting the runtime.
const fakeEntry = (tag: string, namespaceOwner = `test module '${tag}'`, channel = "results"): RegistryEntry => ({
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { [channel]: "application/json" },
                defaultChannel: channel,
                category: "data",
                writableBy: [],
                volatile: true,
                modelVisible: true,
            } as never;
        },
        get defaultChannel() { return channel; },
        get channels() { return { [channel]: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    namespaceOwner: { kind: "module", name: namespaceOwner },
    glyph: "🔌",
    summary: `${tag} fixture.`,
    invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
    details: "",
    available: true,
    detail: "fake",
});

const wire = (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const schemes = new SchemeRegistry();
    const executors = new ExecutorRegistry(new Map());
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    return { schemes, executors, engine };
};

const readStatement = (pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
    target: {
        kind: "url",
        raw: `myserver://${pathname}`,
        scheme: "myserver",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    lineMarker: null,
    matcher: null, body: null,
    position: {
        line: 1,
        column: 1,
    },
});

test("{§extension-namespace-arbitration} module runtime registration adds one dispatchable and model-visible tag", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));
        assert.ok(executors.entry("myserver"), "the server is registered for executor dispatch");
        assert.ok(executors.availableRuntimes().includes("myserver"), "available for the workspace's tool-resource projection");
        assert.ok(schemes.has("myserver"), "scheme face registered - READ/FIND/KILL for the tag");
    } finally { await db.close(); }
});

test("{§extension-namespace-arbitration} module runtime registration preserves one-name-one-owner atomicity", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));

        // Re-registering a live tag is a caller error, not a silent overwrite.
        assert.throws(() => engine.registerRuntime("myserver", fakeEntry("myserver")), /already/i, "dup tag rejected");

        // A reserved built-in scheme name (file/exec/session/…) is rejected by the scheme-first arbitration
        // gate - and because the face is registered BEFORE the executor, the executor registry is never
        // touched on a rejected tag (no half-write).
        assert.throws(() => engine.registerRuntime("session", fakeEntry("session")), /reserved/i, "reserved name rejected");
        assert.equal(executors.entry("session"), undefined, "reserved collision left the executor registry untouched");
        assert.equal(schemes.get("session")?.constructor.name, "Session", "the reserved 'session' scheme is unchanged, not shadowed");

        assert.throws(
            () => engine.registerRuntime("Alias_Tool", fakeEntry("Alias_Tool")),
            /runtime declaration invalid: module runtime name 'Alias_Tool' must match \[a-z\]\[a-z0-9\+\.-\]\*/,
            "module-owned declarations use the same canonical tag admission as installed declarations",
        );
        assert.equal(executors.entry("Alias_Tool"), undefined, "invalid admission leaves the executor registry untouched");
        assert.equal(schemes.has("Alias_Tool"), false, "invalid admission leaves the scheme registry untouched");

        assert.throws(
            () => engine.registerRuntime("only", fakeEntry("only")),
            /runtime declaration invalid: module runtime name 'only' is reserved by PLURNK_EXECS_ONLY/,
            "dynamic registration cannot collide with the policy allowlist key",
        );
        assert.equal(executors.entry("only"), undefined);
        assert.equal(schemes.has("only"), false);
    } finally { await db.close(); }
});

test("{§extension-namespace-arbitration} module runtime registration preflights both registries before mutating either", async () => {
    const db = await openMigrated();
    try {
        const existing = fakeEntry("occupied", "existing module");
        const schemes = new SchemeRegistry();
        const executors = new ExecutorRegistry(new Map([["occupied", existing]]));
        const engine = new Engine({ db, schemes });
        engine.setExecutors(executors);

        assert.throws(
            () => engine.registerRuntime("occupied", fakeEntry("occupied", "incoming module")),
            /daemon module runtime 'existing module'.*daemon module runtime 'incoming module'/,
        );
        assert.equal(schemes.has("occupied"), false, "an executor collision cannot leave a scheme half-written");
        assert.equal(executors.entry("occupied"), existing, "the existing executor remains unchanged");
    } finally { await db.close(); }
});

test("{§execution-output-identity} a runtime resource facet claims only its subtree and preserves output-stream reads", async () => {
    const db = await openMigrated();
    try {
        const { schemes, engine } = wire(db);
        let calls = 0;
        engine.registerRuntime("myserver", fakeEntry("myserver"), {
            claims: (pathname) => pathname.startsWith("/resources/"),
            prepareRepresentation: async (request, ctx) => {
                calls++;
                assert.equal(request.pathname, "/resources/item");
                const written = await ctx.entries.write(request.pathname, {
                    channels: {
                        results: {
                            content: "remote resource",
                            mimetype: "text/plain",
                        },
                    },
                });
                assert.ok(written.status === 200 || written.status === 201);
                return { status: 200 };
            },
        });
        assert.ok(schemes.get("myserver"));
        const workspaceId = await insertWorkspace(db, `module-runtime-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const read = (statement: ReadStatement) => clientRead(engine, db, {
            statement,
            workspaceId,
            sessionId,
        }).then(Results.assertReadResult);

        const remote = await read(readStatement("/resources/item"));
        assert.equal(remote.content, "remote resource");
        assert.equal(calls, 1);

        const output = await read(readStatement("/1/1/1"));
        assert.equal(output.status, 404, "an unclaimed output coordinate uses the standard stream reader");
        assert.equal(calls, 1, "the resource facet never intercepts output coordinates");
    } finally {
        await db.close();
    }
});

test("{§execution-output-identity}: a facet that states its representation owns address, default channel, SEND and the log record on its subtree", async () => {
    const db = await openMigrated();
    try {
        const { engine } = wire(db);
        const sent: string[] = [];
        engine.registerRuntime("peers", fakeEntry("peers"), {
            claims: (pathname) => /^\/[a-z]/u.test(pathname),
            manifest: { authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body" },
            prepareRepresentation: async (request, ctx) => {
                assert.deepEqual([request.authority, request.pathname], ["ada", "/card"], "the facet's authority names the resource");
                const written = await ctx.entries.write(request.pathname, { channels: { body: { content: "ada's card", mimetype: "text/plain" } } });
                assert.ok(written.status === 200 || written.status === 201);
                return { status: 200 };
            },
            send: async (statement) => {
                sent.push(statement.body?.raw ?? "");
                return { status: 200 };
            },
        });
        const workspaceId = await insertWorkspace(db, `facet-representation-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const parse = (body: string) => {
            const parsed = PlurnkParser.parseStatements(body, { executors: fixtureExecutors(body) });
            const item = parsed.items[0];
            if (parsed.items.length !== 1 || item?.kind !== "statement") throw new Error("Expected one operation");
            return item.statement;
        };

        const card = await clientRead(engine, db, { workspaceId, sessionId, statement: parse("````READ (peers://ada/card) <1,-1>````") });
        assert.equal(card.content, "ada's card", "a fragmentless READ selects the facet's default channel, not the executor's");

        let sequence = 0;
        const dispatch = (body: string) => engine.dispatch({ workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model", statement: parse(body) });
        assert.equal((await dispatch("````SEND (peers://ada)\nhello\n````")).status, 200);
        assert.deepEqual(sent, ["hello"], "a claimed SEND is the facet's");
        const stored = await dispatch("````SEND (peers:///1/1/1)\nstdin\n````");
        assert.notEqual(stored.status, 200, "an unclaimed SEND is refused on stored execution output");
        assert.deepEqual(sent, ["hello"], "the facet never sees an execution coordinate");

        const rows = (await db.test_log_entries_by_turn.all<{ scheme: string | null; hostname: string | null; pathname: string | null }>({ turn_id: turnId }))
            .map(({ scheme, hostname, pathname }) => ({ scheme, hostname, pathname }));
        assert.deepEqual(rows[0], { scheme: "peers", hostname: "ada", pathname: "" }, "the log keeps the authored address of a claimed resource");
        assert.deepEqual(rows[1], { scheme: "peers", hostname: null, pathname: "/1/1/1" }, "a stored execution keeps namespace authority");
    } finally {
        await db.close();
    }
});

test("{§scheme-ctx-workspace-environment} {§execution-output-identity}: READ, FIND, COPY, execution, and BARE use the workspace attachment and channel", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "resource-owners");
        const alice = await insertSession(db, workspaceId, null, "alice");
        await insertSession(db, workspaceId, null, "bob");
        await insertSession(db, workspaceId, null, "detached");
        const otherWorkspace = await insertWorkspace(db, "unrelated-resources");
        await insertSession(db, otherWorkspace, null, "outsider");
        const loopId = await insertLoop(db, alice, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const calls: string[] = [];
        for (const [workspace, name] of [[workspaceId, "shared"], [otherWorkspace, "other"]] as const) {
            const channel = name === "shared" ? "results" : "body";
            const facet: RuntimeSchemeFacet = {
                claims: (pathname) => pathname.startsWith("/resources"),
                prepareRepresentation: async (request, ctx) => {
                    calls.push(name);
                    assert.equal(ctx.sessionId, alice, "the caller still owns the operation");
                    const result = await ctx.entries.write(request.pathname, {
                        channels: { [channel]: { content: `${name}'s resource`, mimetype: "text/plain" } },
                    });
                    assert.ok(result.status === 200 || result.status === 201);
                    return { status: 200 };
                },
                find: async (statement, ctx) => ctx.entries.operations.find(statement),
            };
            (await engine.prepareWorkspaceRuntimes(workspace, "fixture", [{ tag: "myserver", entry: fakeEntry("myserver", "fixture", channel), scheme: facet }]))();
        }
        const parse = (body: string) => {
            const parsed = PlurnkParser.parseStatements(body, { executors: fixtureExecutors(body) });
            assert.equal(parsed.unparsedTail, undefined);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return item.statement;
        };
        const read = (uri: string) => clientRead(engine, db, {
            workspaceId, sessionId: alice,
            statement: parse(`\`\`\`\`READ (${uri}) <1,-1>\`\`\`\``),
        });
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource", "repeated reads select the same attachment");
        assert.equal((await read("myserver://absent/resources/item")).status, 404);
        assert.equal((await read("myserver://outsider/resources/item")).status, 404, "resource resolution never crosses workspace identity");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource", "the caller does not need a personal attachment");
        assert.deepEqual(calls, ["shared", "shared", "shared", "shared"]);
        let sequence = 1;
        const dispatch = (body: string) => engine.dispatch({
            workspaceId, sessionId: alice, loopId, turnId, sequence: sequence++, origin: "model",
            statement: parse(body),
        });
        const found = await dispatch("````FIND (myserver:///resources/*) <1,-1>````");
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.match(JSON.stringify(found.results), /myserver:\/\/\/resources\/item/);
        const copied = await dispatch("````COPY (myserver:///resources/item) (workspace:///copy.txt)````");
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const copy = await read("workspace:///copy.txt");
        assert.equal(copy.content, "shared's resource");

        const received: string[] = [];
        const consumer = fakeEntry("consumer");
        engine.registerRuntime("consumer", {
            ...consumer,
            invocation: { body: { role: "arguments", required: false }, target: { role: "resource", required: true, kind: "resource" }, example: { target: "workspace:///program", body: "input" } },
            executor: {
                ...consumer.executor,
                async run(args) {
                    assert.notEqual(args.target, null);
                    received.push(await readFile(args.target!, "utf8"));
                    assert.equal(args.body, "caller input");
                    return { status: 200 };
                },
            },
        });
        const executed = await dispatch(PlurnkParser.frame("consumer (myserver:///resources/item)", "caller input"));
        assert.equal(executed.status, 200, JSON.stringify(executed));
        await (schemes.get("exec") as Exec).idle();
        assert.deepEqual(received, ["shared's resource"]);

        const child = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "Isolated answer.", reasoning: null } }] });
        const result = await engine.runTurn({
            workspaceId, sessionId: alice, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: [
                PlurnkParser.frame("BARE (myserver:///resources/item)", "Analyze this."),
                PlurnkParser.frame("NOTE", "Inspect the answer."),
            ].join("\n\n"), reasoning: null } }] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(child.received.map((messages) => messages.map(chatMessageText)), [["shared's resource\n\nAnalyze this."]]);
    } finally { await db.close(); }
});

test("{§execution-output-identity}: retained output keeps its actual channel after runtime replacement and removal", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "retained-output");
        const sessionId = await insertSession(db, workspaceId);
        const peer = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const declared = fakeEntry("myserver", "fixture", "results");
        const install = async (entries: Parameters<Engine["prepareWorkspaceRuntimes"]>[2]) =>
            (await engine.prepareWorkspaceRuntimes(workspaceId, "fixture", entries))();
        await install([{ tag: "myserver", entry: {
            ...declared,
            executor: {
                ...declared.executor,
                async run({ write }) {
                    write("results", '{"saved":true}', "application/json");
                    return { status: 200 };
                },
            },
        } }]);
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("myserver", "fixture"), { executors: fixtureExecutors(PlurnkParser.frame("myserver", "fixture")) }).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected an operation");
        const invoked = await engine.dispatch({
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model", statement: parsed.statement,
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        await (schemes.get("exec") as Exec).idle();
        const address = await executionAddress(db, turnId);
        const target = readStatement(new URL(address).pathname);
        const read = (reader = engine) => clientRead(reader, db, { workspaceId, sessionId: peer, statement: target });
        await install([{ tag: "myserver", entry: fakeEntry("myserver", "fixture", "body") }]);
        const replaced = await read();
        assert.equal(replaced.status, 200, JSON.stringify(replaced));
        assert.equal(replaced.content, '{"saved":true}');
        assert.equal(replaced.mimetype, "application/json");
        await install([]);
        assert.equal((await read()).content, '{"saved":true}', "removal retains the exact default representation");
        const fresh = wire(db);
        assert.equal(fresh.schemes.has("myserver"), false);
        assert.equal((await read(fresh.engine)).content, '{"saved":true}', "a fresh registry serves saved output without an executable");
    } finally { await db.close(); }
});
});

describe("workspace-env", () => {
test("{§execution-output-identity} workspace defaults, session overrides and masks share the env verbs without copying workspace state", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `env-${crypto.randomUUID()}`);
        const other = await insertWorkspace(db, `other-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        const shared = (verb: string, params: Record<string, unknown> = {}, workspace = workspaceId) =>
            daemon.invokeModuleAction(`workspace.env.${verb}`, params, { scope: "workspace", workspaceId: workspace });
        const local = (sessionId: number, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`session.env.${verb}`, params, { scope: "session", workspaceId, sessionId });
        const get = async (sessionId: number) => ((await local(sessionId, "list")) as FunctionalityListResult).definitions.find(({ alias }) => alias === "ENV_WITNESS");
        await shared("add", { alias: "ENV_WITNESS", definition: { value: "workspace" } });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        assert.equal((await get(alice))?.origin, "workspace");
        assert.equal(((await shared("list", {}, other)) as FunctionalityListResult).definitions.some(({ alias }) => alias === "ENV_WITNESS"), false);
        await local(alice, "add", { alias: "ENV_WITNESS", definition: { value: "alice" } });
        assert.deepEqual((await get(alice))?.definition, { value: "alice" });
        assert.deepEqual((await get(bob))?.definition, { value: "workspace" });
        await local(alice, "remove", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "active");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, "workspace", "removal restores inheritance at the command environment boundary");
        assert.equal((await get(bob))?.state, "active");
        await local(alice, "disable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled");
        await local(alice, "enable", { alias: "ENV_WITNESS" });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        await shared("disable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled", "removing a session mask cannot lift a workspace mask");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, undefined);
        await shared("enable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "active");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, "workspace");
        const child = await insertSession(db, workspaceId, bob, "child", "model");
        await shared("remove", { alias: "ENV_WITNESS" });
        await shared("add", { alias: "ENV_WITNESS", definition: { value: "updated" } });
        assert.deepEqual((await get(child))?.definition, { value: "updated" }, "workspace values stay live through parentage");
        await assert.rejects(shared("add", { alias: "PLURNK_BAD", definition: { value: "x" } }), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/name-reserved");
            assert.equal(cause.result.problem.detail, "'PLURNK_BAD' is reserved in env entries.");
            assert.equal(cause.result.problem.recovery, "READ workspace:///_plurnk/tools/plurnk/env.json for supported configuration paths.");
            return true;
        });
        await assert.rejects(shared("list", { scope: "session" }), /scope does not match/u);
        await assert.rejects(local(alice, "list", { scope: "workspace" }), /scope does not match/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("workspaces", () => {
test("{§execution-output-identity} workspaces: name UNIQUE — duplicate insert is rejected", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "workspace-a" });
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "workspace-a" }),
            /UNIQUE constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity} workspaces: empty name rejected by CHECK (length > 0)", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} workspaces: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_with_version.run({ name: "workspace-c", version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity} workspaces: NOT NULL enforced on name", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_no_name(),
            /NOT NULL constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});
});
