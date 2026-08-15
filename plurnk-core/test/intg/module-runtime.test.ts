// Module-owned runtimes register through one protocol-neutral seam. The engine
// adds the executor tag and its output scheme atomically while a resource facet
// may claim a distinct subtree under that same scheme.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor, RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import type { ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { Results } from "@plurnk/plurnk-schemes";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

// A stand-in executor - the seam stores the entry + wraps the executor in a lazy scheme face
// (ExecOutputScheme reads the executor only at dispatch), so registration needs no live runtime.
const fakeEntry = (tag: string, namespaceOwner = `test module '${tag}'`): RegistryEntry => ({
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { results: "application/json" },
                defaultChannel: "results",
                category: "data",
                writableBy: ["plugin"],
                volatile: true,
                modelVisible: true,
                authority: "semantic",
            } as never;
        },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    namespaceOwner: { kind: "module", name: namespaceOwner },
    glyph: "🔌",
    invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
    documentation: "",
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

const readStatement = (pathname: string, hostname: string | null = null): ReadStatement => ({
    op: "READ",
    suffix: "",
    signal: null,
    target: {
        kind: "url",
        raw: hostname === null ? `myserver://${pathname}` : `myserver://${hostname}${pathname}`,
        scheme: "myserver",
        username: null,
        password: null,
        hostname,
        port: null,
        pathname,
        query: null,
        fragment: null,
    } as UrlPath,
    lineMarker: null,
    body: null,
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
        assert.ok(executors.entry("myserver"), "tag in the executor registry - dispatch resolves EXEC[myserver]");
        assert.ok(executors.availableRuntimes().includes("myserver"), "offered to the model on the next packet's tools sheet");
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
            claims: (target) => target.kind === "url"
                && (target.pathname.startsWith("/resources/")
                    || (target.hostname === "contract" && target.pathname === "/")),
            resolveEntryAddress: async (target) => target.kind === "url" && target.hostname === "contract"
                ? { pathname: "/tools/contract", owner: "commons" }
                : { pathname: target.kind === "url" ? target.pathname : target.raw, owner: "commons" },
            prepareRepresentation: async (request, ctx) => {
                calls++;
                assert.ok(request.pathname === "/resources/item" || request.pathname === "/tools/contract");
                const written = await ctx.entries.write(request.pathname, {
                    channels: {
                        results: {
                            content: request.pathname === "/tools/contract" ? "tool contract" : "remote resource",
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

        const contract = await read(readStatement("/", "contract"));
        assert.equal(contract.content, "tool contract");
        assert.equal(calls, 2);

        const output = await read(readStatement("/1/1/1"));
        assert.equal(output.status, 404, "an unclaimed output coordinate uses the standard stream reader");
        assert.equal(calls, 2, "the resource facet never intercepts output coordinates");
    } finally {
        await db.close();
    }
});
