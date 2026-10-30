import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ExecutorRegistry, { type RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import ExecScratch from "../../src/schemes/ExecScratch.ts";
import Results from "../../src/core/results.ts";
import { ownSession } from "./_approval.ts";
import { type ExecStatement, type RuntimeTag, isExecution } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { testExecutors } from "./_execs.ts";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";
import { type Executor, BaseExecutor, type Effect, type ExecArgs, type ExecInput, type RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import { type SchemeManifest } from "../../src/core/types.ts";
import { localPath, readStmt, urlPath } from "./_dsl.ts";
import { mkdtemp, writeFile, mkdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { waitForDb } from "./_rpc.ts";


describe("Exec.scheme", () => {
// Exec scheme — the execution op handler per plurnk.md.
//   ### EXEC_ [runtime] (target)\nbody
// Auto-generates a `<runtime>:///<loop>/<turn>/<seq>` entry (the runtime tag IS the
// authority); spawns the subprocess; streams stdout/stderr into channels; closes
// subscription + transitions channel state at exit.



















// {§op-shapes} — a null runtime is the bare shell; the target is the program or working directory.
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

test("{§op-shapes} execution: empty body and absent target → 400", async () => {
    await withWorkspace(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt(null, null, ""),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    });
});

test("{§op-shapes} Exec.applyResolution: malformed accepted proposal state remains an internal invariant", async () => {
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
test("{§op-shapes} bare execution defaults to sh and proposes with {runtime, cwd, body, pathname}", async () => {
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
    test(`{§executor-subprocess} ${source} script receives exact tokenized argv and workspace cwd`, async () => {
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

test("{§op-shapes} sh: clean exit → channels at state=closed, stdout captured, subscription closed at 200", async () => {
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

test("{§executor-results} sh: an exit code is the answer: channels closed, stderr captured, subscription closed at 200", async () => {
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

test("{§op-shapes} execution: cwd defaults to workspace.project_root when statement target is null", async () => {
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

test("{§op-shapes} execution: subscription row opens then closes; stream/event fires per chunk + transition", async () => {
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
    schemes.registerRuntimeSchemes(executors); // {§network-address} Register per-tag READ faces as daemon boot does.
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

// {§exec-target-routing} {§executor-contract}: cwd and target remain distinct inputs.
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

test("{§executor-discovery} exact tools own admission and their invocation contract", async () => {
    const ctx = await wire();
    try {
        const reference = await ctx.engine.referenceEntries(ctx.workspaceId);
        const runtimeDoc = reference.find((doc) => doc.scheme === "plurnk" && doc.pathname === "/registrytool.md");
        assert.match(runtimeDoc?.content ?? "", /```registrytool \(enabled_tool\)/, "the runtime document carries every registered target");
        assert.equal(
            reference.some((doc) => doc.pathname.startsWith("/registrytool/")),
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
        assert.equal(disabled.problem?.recovery, "Select a target from plurnk:///registrytool.md.");
        assert.ok(reference.some(({ scheme, pathname }) => disabled.problem?.recovery === `Select a target from ${scheme}://${pathname}.`),
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

test("{§tools-resource-materialization} target recovery follows a runtime's declared document root", async () => {
    for (const [resourcesPath, expectedScheme] of [["/tools", "mcp"], ["/modules/custom", "plurnk"]] as const) {
        const ctx = await wire(resourcesPath);
        try {
            const result = await ctx.dispatch(statement("registrytool", "missing", "{}"));
            assert.equal(result.status, 404);
            const documents = await ctx.engine.referenceEntries(ctx.workspaceId);
            const path = "/registrytool.md";
            assert.equal(result.problem?.recovery, `Select a target from ${expectedScheme}://${path}.`);
            const document = documents.find(({ scheme, pathname }) => scheme === expectedScheme && pathname === path);
            assert.ok(document, "the recovery document is actually published");
            assert.match(document.content, /enabled_tool/u);
        } finally { await ctx.close(); }
    }
});

test("{§executor-discovery} required and unsupported buckets are refused before execution", async () => {
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

// {§executor-discovery} Each blank an invocation can be: a registry runtime without its target, a registered target
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
    test(`{§executor-discovery}: ${blank.runtime}${blank.target === null ? "" : ` (${blank.target})`} refused as ${blank.code} answers with its working form`, async () => {
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

test("{§executor-discovery} an exclusive runtime refuses body plus target", async () => {
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

test("{§executor-contract} a tool owns opaque options even when its literal target looks like another scheme", async () => {
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

test("{§executor-contract} absent and rejecting preparation refuse options before effect admission", async () => {
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

test("{§executor-contract} a malformed preparation is an internal failure before execution", async () => {
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

