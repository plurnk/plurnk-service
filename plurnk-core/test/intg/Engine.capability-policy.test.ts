// {§capability-admission} — every operation route is admitted through the same
// service/workspace/worker-bound/worker/loop capability cascade before either
// execution or proposal settlement. This is the composed dispatch boundary;
// selector algebra itself belongs to @plurnk/plurnk-contracts.

import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Effect } from "@plurnk/plurnk-execs";
import type { RepresentationPreparationRequest, SchemeCtx } from "@plurnk/plurnk-schemes";
import type { CapabilityPolicy, LoopPolicy } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertOperationTurn, schemeManifest } from "./_helpers.ts";
import { urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, sendStmt, execStmt } from "./_dsl.ts";

const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
});

class WritableScheme {
    static manifest: SchemeManifest = {
        name: "write-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        entryOwner: "commons",
        inherit: "none",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        modelVisible: true,
    };

    async editBatch(): Promise<{ status: number }> {
        return { status: 201 };
    }
}

class TraitSource {
    readonly manifest: SchemeManifest;
    preparations = 0;

    constructor(name: string, traits: readonly string[]) {
        this.manifest = { ...schemeManifest(name), traits };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<{ status: number }> {
        this.preparations += 1;
        await ctx.entries.write(request.pathname, {
            channels: { body: { content: "source", mimetype: "text/plain" } },
        });
        return { status: 200 };
    }
}

const fixtureExecutor: Executor = {
    runtime: "fixture-tool",
    glyph: "🧪",
    get manifest(): SchemeManifest {
        return {
            ...schemeManifest("fixture-tool", { results: "text/plain" }, "results"),
            volatile: true,
        };
    },
    get defaultChannel(): string { return "results"; },
    get channels() { return { results: { mimetype: "text/plain" } }; },
    async run({ setState }) {
        setState("results", "closed");
        return { status: 200 };
    },
    async probe() { return { available: true }; },
    effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
};

const registryEntry = (executor: Executor, literal = false) => ({
    executor,
    namespaceOwner: { kind: "module" as const, name: `${executor.runtime} fixture` },
    glyph: executor.glyph,
    summary: "Capability fixture.",
    invocation: literal
        ? { body: { role: "input", required: false }, target: { role: "tool identifier", required: true, kind: "literal" as const }, example: { target: "fixture_tool", body: "{}" } }
        : { body: { role: "input", required: true }, target: { role: "resource", required: false, kind: "resource" as const }, example: { body: "fixture" } },
    details: "",
    available: true,
    detail: undefined,
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertOperationTurn(db, loopId, 1, "client");
    const schemes = new SchemeRegistry();
    schemes.register("write-test", new WritableScheme());
    const engine = new Engine({ db, schemes, mimetypes: makeMimetypes() });
    engine.setExecutors(new ExecutorRegistry(new Map([
        ["fixture-tool", registryEntry(fixtureExecutor)],
        ["literal-tool", registryEntry(fixtureExecutor, true)],
    ])));
    return { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec: schemes.get("exec") as Exec };
};

const loopPolicy = (capabilities: CapabilityPolicy = {}, proposals: LoopPolicy["proposals"] = "review"): LoopPolicy => ({
    capabilities,
    proposals,
});

const setLoopPolicy = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    loopId: number,
    policy: LoopPolicy,
): Promise<void> => {
    await db.engine_set_loop_policy.run({ loop_id: loopId, policy: JSON.stringify(policy) });
};

test("invalid persisted loop policy fails at its durable owner before dispatch", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await db.engine_set_loop_policy.run({ loop_id: loopId, policy: JSON.stringify({ capabilities: {}, proposals: "sometimes" }) });
        await assert.rejects(
            engine.dispatch({
                statement: editStmt(urlPath("write-test", "x"), "body"),
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Loop ${loopId} has invalid persisted policy.`);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    } finally { await db.close(); }
});

test("one access selector gates every matching mutation shape while observations remain admitted", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ access: "mutate" }] }));
        let sequence = 0;
        const dispatch = (statement: Parameters<typeof engine.dispatch>[0]["statement"]) =>
            engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "client" });
        for (const statement of [
            editStmt(localPath("brief.md"), "hello"),
            copyStmt(urlPath("worker", "note"), localPath("copied.md")),
            moveStmt(localPath("brief.md"), urlPath("worker", "moved")),
        ]) {
            const result = await dispatch(statement);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
            assert.equal(result.problem?.access, "mutate");
            assert.equal(result.problem?.policyScope, "loop");
            assert.equal(result.problem?.retryable, false);
            assert.equal(result.problem?.recovery, undefined, "a factual denial does not guess at model intent");
        }
        assert.notEqual((await dispatch(readStmt(localPath("brief.md")))).status, 403);
    } finally { await db.close(); }
});

test("a MOVE source requires observation as well as mutation authority", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ access: "observe", scheme: "file" }] }));
        const result = await engine.dispatch({
            statement: moveStmt(localPath("secret.txt"), urlPath("worker", "/moved.txt")),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.operation, "MOVE");
        assert.equal(result.problem?.scheme, "file");
        assert.equal(result.problem?.access, "observe");
    } finally { await db.close(); }
});

test("proposal disposition cannot deny or resurrect a capability", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopPolicy(db, loopId, loopPolicy({}, "reject"));
        const admitted = await engine.dispatch({
            statement: editStmt(urlPath("worker", "/x"), "body"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(admitted.status, 201, "proposal settlement is downstream of admission");

        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ operation: "EDIT" }] }, "accept"));
        const denied = await engine.dispatch({
            statement: editStmt(urlPath("worker", "/y"), "body"),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "client",
        });
        assert.equal(denied.status, 403, "automatic acceptance cannot restore denied authority");
    } finally { await db.close(); }
});

test("an operation with no external capability demand remains available under an empty only-set", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ only: [] }));
        const result = await engine.dispatch({
            statement: sendStmt(200, null),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("unknown routes reach ordinary resolution even under matching capability denials", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [
            { operation: "READ" },
            { operation: "EXEC" },
        ] }));
        const result = await engine.dispatch({
            statement: readStmt(urlPath("unknown-source", "/item")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 501);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(result.problem?.scheme, "unknown-source");

        const runtime = await engine.dispatch({
            statement: execStmt("unknown-runtime", "input", null),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "client",
        });
        assert.equal(runtime.status, 501);
        assert.equal(runtime.problem?.type, "https://problems.plurnk.xyz/scheme/exec/runtime-not-registered");

        const copy = await engine.dispatch({
            statement: copyStmt(urlPath("unknown-source", "/item"), urlPath("worker", "/copy")),
            workspaceId, workerId, loopId, turnId, sequence: 3, origin: "client",
        });
        assert.equal(copy.status, 501);
        assert.equal(copy.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(copy.problem?.scheme, "unknown-source");

        const source = await engine.dispatch({
            statement: execStmt("fixture-tool", "input", urlPath("unknown-source", "/item")),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "client",
        });
        assert.equal(source.status, 501);
        assert.equal(source.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(source.problem?.scheme, "unknown-source");
    } finally { await db.close(); }
});

test("EXEC admission precedes every target acquisition shape", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ operation: "EXEC" }] }));
        const targets = [null, localPath("input.txt"), urlPath("file", "/input.txt"), urlPath("worker", "/source"), urlPath("web-source", "/source")];
        for (const [index, target] of targets.entries()) {
            const result = await engine.dispatch({
                statement: execStmt("fixture-tool", "transform", target),
                workspaceId, workerId, loopId, turnId, sequence: index + 1, origin: "client",
            });
            assert.equal(result.status, 403);
            assert.equal(result.problem?.operation, "EXEC");
        }
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("a resource-shaped EXEC target adds its own observe demand", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ traits: ["web"] }] }));
        const result = await engine.dispatch({
            statement: execStmt("fixture-tool", "transform", urlPath("web-source", "/source")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.scheme, "web-source");
        assert.equal(result.problem?.access, "observe");
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("a literal EXEC target is a tool identifier, never a resource route", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ traits: ["web"] }] }, "accept"));
        const result = await engine.dispatch({
            statement: execStmt("literal-tool", "{}", urlPath("web-source", "/tool")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 200);
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("runtime scheme traits participate in the same selector space", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine, exec } = await setup();
    const interactive: Executor = {
        ...fixtureExecutor,
        runtime: "ask-human",
        get manifest(): SchemeManifest {
            return {
                ...schemeManifest("ask-human", { results: "text/plain" }, "results"),
                traits: ["interaction"],
                volatile: true,
            };
        },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
    };
    engine.registerRuntime("ask-human", registryEntry(interactive));
    try {
        await setLoopPolicy(db, loopId, loopPolicy({ deny: [{ traits: ["interaction"] }] }));
        const denied = await engine.dispatch({
            statement: execStmt("ask-human", "{}", null),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.problem?.runtime, "ask-human");
        assert.deepEqual(denied.problem?.traits, ["interaction"]);
    } finally { await exec.idle(); await db.close(); }
});
