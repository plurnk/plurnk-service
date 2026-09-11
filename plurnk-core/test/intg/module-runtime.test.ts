// Module-owned runtimes register through one protocol-neutral seam. The engine
// adds the executor tag and its output scheme atomically while a resource facet
// may claim a distinct subtree under that same scheme.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor, RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import { PlurnkParser, type ReadStatement, type UrlPath } from "@plurnk/plurnk-contracts";
import type { RuntimeSchemeFacet } from "../../src/server/DaemonModule.ts";
import { Results } from "@plurnk/plurnk-schemes";
import type Exec from "../../src/schemes/Exec.ts";
import { executionAddress, insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

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
                writableBy: ["plugin"],
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
    } as UrlPath,
    lineMarker: null,
    matcher: null, body: null,
    position: {
        line: 1,
        column: 1,
    },
});

test("module runtime registration adds one dispatchable and model-visible tag", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));
        assert.ok(executors.entry("myserver"), "the server is registered for executor dispatch");
        assert.ok(executors.availableRuntimes().includes("myserver"), "available for the workspace's tool-resource projection");
        assert.ok(schemes.has("myserver"), "scheme face registered - READ/FIND/KILL for the tag");
    } finally { await db.close(); }
});

test("module runtime registration preserves one-name-one-owner atomicity", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));

        // Re-registering a live tag is a caller error, not a silent overwrite.
        assert.throws(() => engine.registerRuntime("myserver", fakeEntry("myserver")), /already/i, "dup tag rejected");

        // A reserved built-in scheme name (file/exec/worker/…) is rejected by the scheme-first arbitration
        // gate - and because the face is registered BEFORE the executor, the executor registry is never
        // touched on a rejected tag (no half-write).
        assert.throws(() => engine.registerRuntime("worker", fakeEntry("worker")), /reserved/i, "reserved name rejected");
        assert.equal(executors.entry("worker"), undefined, "reserved collision left the executor registry untouched");
        assert.equal(schemes.get("worker")?.constructor.name, "Worker", "the reserved 'worker' scheme is unchanged, not shadowed");

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

test("module runtime registration preflights both registries before mutating either", async () => {
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

test("a runtime resource facet claims only its subtree and preserves output-stream reads", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const read = (statement: ReadStatement) => engine.look({
            statement,
            workspaceId,
            workerId,
            loopId,
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

test("{§runtime-resource-binding}: READ, FIND, COPY, EXEC, and BARE use the workspace attachment and channel", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "resource-owners");
        const alice = await insertWorker(db, workspaceId, null, "alice");
        await insertWorker(db, workspaceId, null, "bob");
        await insertWorker(db, workspaceId, null, "detached");
        const otherWorkspace = await insertWorkspace(db, "unrelated-resources");
        await insertWorker(db, otherWorkspace, null, "outsider");
        const loopId = await insertLoop(db, alice, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const calls: string[] = [];
        for (const [workspace, name] of [[workspaceId, "shared"], [otherWorkspace, "other"]] as const) {
            const channel = name === "shared" ? "results" : "body";
            const facet: RuntimeSchemeFacet = {
                claims: (pathname) => pathname.startsWith("/resources"),
                prepareRepresentation: async (request, ctx) => {
                    calls.push(name);
                    assert.equal(ctx.workerId, alice, "the caller still owns the operation");
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
            const parsed = PlurnkParser.parseStatements(body);
            assert.equal(parsed.unparsedTail, undefined);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return item.statement;
        };
        const read = (uri: string) => engine.look({
            workspaceId, workerId: alice, loopId,
            statement: parse(`\`\`\`READ (${uri}) <1,-1>\`\`\``),
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
            workspaceId, workerId: alice, loopId, turnId, sequence: sequence++, origin: "model",
            statement: parse(body),
        });
        const found = await dispatch("```FIND (myserver:///resources/*) <1,-1>```");
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.match(JSON.stringify(found.results), /myserver:\/\/\/resources\/item/);
        const copied = await dispatch("```COPY (myserver:///resources/item) (worker:///copy.txt)```");
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const copy = await read("worker:///copy.txt");
        assert.equal(copy.content, "shared's resource");

        const received: string[] = [];
        const consumer = fakeEntry("consumer");
        engine.registerRuntime("consumer", {
            ...consumer,
            invocation: { body: { role: "stdin", required: false }, target: { role: "resource", required: true, kind: "resource" }, example: { target: "worker:///program", body: "input" } },
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
            workspaceId, workerId: alice, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: [
                PlurnkParser.frame("BARE (myserver:///resources/item)", "Analyze this."),
                PlurnkParser.frame("TASK", '[{"content":"Inspect the answer.","status":"in_progress"}]'),
            ].join("\n\n"), reasoning: null } }] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(child.received.map((messages) => messages.map(chatMessageText)), [["shared's resource\n\nAnalyze this."]]);
    } finally { await db.close(); }
});

test("{§runtime-resource-binding}: retained output keeps its actual channel after runtime replacement and removal", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "retained-output");
        const workerId = await insertWorker(db, workspaceId);
        const peer = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
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
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("myserver", "fixture")).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected an operation");
        const invoked = await engine.dispatch({
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model", statement: parsed.statement,
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        await (schemes.get("exec") as Exec).idle();
        const address = await executionAddress(db, turnId);
        const target = readStatement(new URL(address).pathname);
        const read = (reader = engine) => reader.look({ workspaceId, workerId: peer, loopId, statement: target });
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
