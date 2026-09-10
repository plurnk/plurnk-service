import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { BaseExecutor, type ExecArgs, type Effect } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry, { type Executor } from "../../src/core/ExecutorRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import Common from "@plurnk/plurnk-execs-common";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

class Dialogue extends BaseExecutor {
    readonly received: Array<{ body: string; metadata: readonly string[] | null }> = [];
    readonly finished = Promise.withResolvers<void>();
    readonly started = Promise.withResolvers<void>();
    readonly classification: Effect;
    readonly acceptsInput: boolean;
    constructor(effect: Effect = "pure", acceptsInput = true) {
        super({ runtime: "dialogue", glyph: "d" });
        this.classification = effect;
        this.acceptsInput = acceptsInput;
    }
    get channels() { return { results: { mimetype: "text/plain" } }; }
    override effect() { return this.classification; }
    async run(args: ExecArgs) {
        if (this.acceptsInput) args.registerInput?.(async ({ body, metadata }) => {
            this.received.push({ body, metadata });
            args.write("results", body);
            return { status: 200, result: { accepted: true } };
        });
        this.started.resolve();
        args.signal.addEventListener("abort", () => this.finished.resolve(), { once: true });
        await this.finished.promise;
        return { status: 200 };
    }
}

const fixture = async (executor: Executor, workerScoped = false) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    const entry = {
        executor, namespaceOwner: { kind: "module" as const, name: "input fixture" }, glyph: "d",
        summary: "Interactive fixture", invocation: { body: { role: "program", required: true }, signature: "program" },
        details: "", available: true, detail: undefined,
    };
    const registry = new ExecutorRegistry(new Map(workerScoped ? [] : [[executor.runtime, entry]]));
    engine.setExecutors(registry);
    schemes.registerRuntimeSchemes(registry);
    const workspaceId = await insertWorkspace(db, `input-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1, 102);
    if (workerScoped) {
        registry.prepareWorkerRegistrations(workerId, "input fixture", [{ tag: executor.runtime, entry }])();
        (await schemes.prepareWorkerRuntimeSchemes(workerId, "input fixture", [{ tag: executor.runtime, executor, owner: entry.namespaceOwner }]))();
    }
    let sequence = 0;
    const dispatch = (source: string, onDispatch?: (id: number) => void) => {
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0]!;
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("Expected a statement");
        return engine.dispatch({ statement: item.statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "model", onDispatch });
    };
    return { db, engine, schemes, dispatch, workerId, workspaceId, loopId, turnId,
        withdraw: async () => {
            registry.prepareWorkerRegistrations(workerId, "input fixture", [])();
            (await schemes.prepareWorkerRuntimeSchemes(workerId, "input fixture", []))();
        },
        close: async () => { await (schemes.get("exec") as Exec).idle(); await db.close(); } };
};

test("{§exec-input}: SEND reaches an invocation-local plugin receiver without altering output authority", async () => {
    const executor = new Dialogue();
    const f = await fixture(executor);
    try {
        assert.equal((await f.dispatch("```dialogue\nstart\n```")).status, 200);
        await executor.started.promise;
        const result = await f.dispatch("```SEND (dialogue:///1/1/1/dialogue) {custom=exact}\nraw {JSON} and newline\n\n```");
        assert.equal(result.status, 200);
        assert.equal(result.accepted, true);
        assert.deepEqual(executor.received, [{ body: "raw {JSON} and newline\n", metadata: ["custom=exact"] }]);
        assert.deepEqual(f.schemes.manifestFor("dialogue", f.workerId)?.writableBy, ["plugin"]);
        assert.equal((await f.dispatch("```EDIT (dialogue:///1/1/1/dialogue)\nnot input\n```")).status, 403);
        assert.equal((await f.dispatch("```READ (dialogue:///1/1/1/dialogue) {custom=exact}```")).status, 400);
        assert.equal((await f.dispatch("```FIND (dialogue:///*) {custom=exact}```")).status, 400);
        executor.finished.resolve();
        await (f.schemes.get("exec") as Exec).idle();
        const closed = await f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\ntoo late\n```");
        assert.equal(closed.status, 410);
        assert.equal(executor.received.length, 1);
        assert.equal((await f.dispatch("```SEND (dialogue:///99/99/99/dialogue)\nmissing\n```")).status, 404);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: queued input returns promptly and never steals the running invocation's receiver", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    const executor = new Dialogue();
    const f = await fixture(executor);
    try {
        await f.dispatch("```dialogue\nfirst\n```");
        await executor.started.promise;
        assert.equal((await f.dispatch("```dialogue\nqueued\n```")).status, 202);
        const result = await f.dispatch("```SEND (dialogue:///1/1/2/dialogue)\nnot delivered\n```");
        assert.equal(result.status, 409);
        assert.match(result.problem?.type ?? "", /input-unavailable$/);
        assert.equal(executor.received.length, 0);
        assert.equal((await f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nfirst only\n```")).status, 200);
        assert.equal(executor.received.length, 1);
        await f.dispatch("```KILL (dialogue:///1/1/2/dialogue)```");
    } finally {
        executor.finished.resolve();
        await f.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-input}: owner, SEND capability, and original runtime capability are independent gates", async () => {
    const executor = new Dialogue();
    const f = await fixture(executor);
    try {
        await f.dispatch("```dialogue\nfirst\n```");
        await executor.started.promise;
        await insertWorker(f.db, f.workspaceId, null, "other-input-owner");
        const other = await f.dispatch("```SEND (dialogue://other-input-owner/1/1/1/dialogue)\nno\n```");
        assert.equal(other.status, 403);
        assert.match(other.problem?.type ?? "", /input-owner-forbidden$/);
        for (const deny of [{ operation: "SEND" }, { operation: "EXEC", runtime: "dialogue" }]) {
            await f.db.engine_set_loop_policy.run({ loop_id: f.loopId, policy: JSON.stringify({ proposals: "review", capabilities: { deny: [deny] } }) });
            const result = await f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nno\n```");
            assert.equal(result.status, 403);
            assert.match(result.problem?.type ?? "", /capability-denied$/);
        }
        assert.equal(executor.received.length, 0);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: host input proposes before delivery; rejection and stale approval do not write", async () => {
    const executor = new Dialogue("host");
    const f = await fixture(executor);
    const resolve = async (source: string, decision: "accept" | "reject", before?: () => Promise<void>) => {
        const id = Promise.withResolvers<number>();
        const pending = f.dispatch(source, id.resolve);
        const logId = await id.promise;
        await before?.();
        f.engine.resolveProposal(logId, { decision });
        return pending;
    };
    try {
        assert.equal((await resolve("```dialogue\nstart\n```", "accept")).status, 200);
        await executor.started.promise;
        const send = "```SEND (dialogue:///1/1/1/dialogue)\nhello\n```";
        const rejected = await resolve(send, "reject", async () => { assert.equal(executor.received.length, 0); });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.problem?.type, "https://problems.plurnk.xyz/proposal/rejected");
        assert.equal(executor.received.length, 0);
        assert.equal((await resolve(send, "accept")).status, 200);
        assert.equal(executor.received.length, 1);
        const stale = await resolve(send, "accept", async () => {
            executor.finished.resolve();
            await (f.schemes.get("exec") as Exec).idle();
        });
        assert.equal(stale.status, 410);
        assert.equal(executor.received.length, 1);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: capability revocation while input awaits approval prevents delivery", async () => {
    const executor = new Dialogue("host");
    const f = await fixture(executor);
    try {
        const startId = Promise.withResolvers<number>();
        const start = f.dispatch("```dialogue\nstart\n```", startId.resolve);
        f.engine.resolveProposal(await startId.promise, { decision: "accept" });
        assert.equal((await start).status, 200);
        await executor.started.promise;
        const inputId = Promise.withResolvers<number>();
        const pending = f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nnot delivered\n```", inputId.resolve);
        const logId = await inputId.promise;
        await f.db.engine_set_loop_policy.run({ loop_id: f.loopId, policy: JSON.stringify({ proposals: "review", capabilities: { deny: [{ operation: "EXEC", runtime: "dialogue" }] } }) });
        f.engine.resolveProposal(logId, { decision: "accept" });
        const denied = await pending;
        assert.equal(denied.status, 403);
        assert.match(denied.problem?.type ?? "", /capability-denied$/);
        assert.equal(executor.received.length, 0);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: real node launch, SEND, EOF, and READ compose through the dispatcher", async () => {
    const f = await fixture(new Common({ runtime: "node", glyph: "n" }));
    try {
        await f.db.engine_set_loop_policy.run({ loop_id: f.loopId, policy: JSON.stringify({ proposals: "accept", capabilities: {} }) });
        const start = await f.dispatch("````node {stdin=open}\nprocess.stdin.on('data', d => process.stdout.write(d));\n````");
        assert.equal(start.status, 200);
        const sent = await f.dispatch("````SEND (node:///1/1/1/node) {eof=true}\nexact α\n\n````");
        assert.equal(sent.status, 200);
        assert.equal(sent.bytesAccepted, Buffer.byteLength("exact α\n"));
        assert.equal(sent.inputClosed, true);
        await (f.schemes.get("exec") as Exec).idle();
        const read = await f.dispatch("```READ (node:///1/1/1/node) <1,-1>```");
        assert.equal(read.status, 200);
        assert.match(String(read.content), /exact α/);
    } finally {
        await f.dispatch("```KILL (node:///1/1/1/node)```");
        await f.close();
    }
});

test("{§exec-input}: withdrawing a runtime while input awaits approval is not successful delivery", async () => {
    const executor = new Dialogue("host");
    const f = await fixture(executor, true);
    try {
        const startId = Promise.withResolvers<number>();
        const start = f.dispatch("```dialogue\nstart\n```", startId.resolve);
        f.engine.resolveProposal(await startId.promise, { decision: "accept" });
        assert.equal((await start).status, 200);
        await executor.started.promise;
        const inputId = Promise.withResolvers<number>();
        const pending = f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nno\n```", inputId.resolve);
        const logId = await inputId.promise;
        await f.withdraw();
        f.engine.resolveProposal(logId, { decision: "accept" });
        const result = await pending;
        assert.equal(result.status, 410);
        assert.match(result.problem?.type ?? "", /handler-unavailable$/);
        assert.equal(executor.received.length, 0);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: execution KILL retires its receiver before further SEND can deliver", async () => {
    const executor = new Dialogue();
    const f = await fixture(executor);
    try {
        await f.dispatch("```dialogue\nstart\n```");
        await executor.started.promise;
        assert.equal((await f.dispatch("```KILL (dialogue:///1/1/1/dialogue)```")).status, 200);
        const result = await f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nnever\n```");
        assert.equal(result.status, 410);
        assert.match(result.problem?.type ?? "", /input-closed$/);
        assert.equal(executor.received.length, 0);
    } finally { executor.finished.resolve(); await f.close(); }
});

test("{§exec-input}: a running executor without an input receiver rejects SEND without hanging", async () => {
    const executor = new Dialogue("read", false);
    const f = await fixture(executor);
    try {
        assert.equal((await f.dispatch("```dialogue\nstart\n```")).status, 200);
        await executor.started.promise;
        const result = await f.dispatch("```SEND (dialogue:///1/1/1/dialogue)\nnot delivered\n```");
        assert.equal(result.status, 409);
        assert.match(result.problem?.type ?? "", /input-unavailable$/);
        assert.equal(executor.received.length, 0);
        for (const operand of ["(dialogue:///1/1/1/dialogue#results)", "(dialogue:///1/1/1/dialogue) <1>"]) {
            const invalid = await f.dispatch(`\`\`\`SEND ${operand}\nx\n\`\`\``);
            assert.equal(invalid.status, 400);
            assert.match(invalid.problem?.type ?? "", /invalid-input-target$/);
        }
    } finally { executor.finished.resolve(); await f.close(); }
});
