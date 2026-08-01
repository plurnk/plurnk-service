// Module-owned runtimes register through one protocol-neutral seam. The engine
// adds the executor tag and its output scheme atomically while a resource facet
// may claim a distinct subtree under that same scheme.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor, RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import type { ReadStatement, UrlPath } from "@plurnk/plurnk-contracts/grammar";
import type ExecOutputScheme from "../../src/schemes/ExecOutputScheme.ts";
import { openMigrated, makeSchemeCtx } from "./_helpers.ts";

// A stand-in executor - the seam stores the entry + wraps the executor in a lazy scheme face
// (ExecOutputScheme reads the executor only at dispatch), so registration needs no live runtime.
const fakeEntry = (tag: string): RegistryEntry => ({
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { results: "application/json" },
                defaultChannel: "results",
                category: "data",
                scope: "workspace",
                writableBy: ["plugin"],
                volatile: true,
                modelVisible: true,
            } as never;
        },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    glyph: "🔌", example: `<<EXEC[${tag}]:?:EXEC`, documentation: "", available: true, detail: "fake",
});

const wire = (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const schemes = new SchemeRegistry();
    const executors = new ExecutorRegistry(new Map());
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    return { schemes, executors, engine };
};

const readStatement = (pathname: string): ReadStatement => ({
    op: "READ",
    suffix: "",
    signal: null,
    target: {
        kind: "url",
        raw: `myserver://${pathname}`,
        scheme: "myserver",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        params: {},
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

        // A reserved built-in scheme name (known/exec/run/…) is rejected by the scheme-first arbitration
        // gate - and because the face is registered BEFORE the executor, the executor registry is never
        // touched on a rejected tag (no half-write).
        assert.throws(() => engine.registerRuntime("worker", fakeEntry("worker")), /reserved/i, "reserved name rejected");
        assert.equal(executors.entry("worker"), undefined, "reserved collision left the executor registry untouched");
        assert.equal(schemes.get("worker")?.constructor.name, "Worker", "the reserved 'worker' scheme is unchanged, not shadowed");
    } finally { await db.close(); }
});

test("a runtime resource facet claims only its subtree and preserves output-stream reads", async () => {
    const db = await openMigrated();
    try {
        const { schemes, engine } = wire(db);
        let calls = 0;
        engine.registerRuntime("myserver", fakeEntry("myserver"), {
            claims: (pathname) => pathname.startsWith("/resources/"),
            read: async (_statement, ctx) => {
                calls++;
                assert.ok(ctx.entries, "the module receives the public scheme context");
                return {
                    status: 200,
                    content: "remote resource",
                    mimetype: "text/plain",
                    channel: "body",
                };
            },
        });
        const handler = schemes.get("myserver") as ExecOutputScheme;
        const ctx = makeSchemeCtx({ db });

        const remote = await handler.read(readStatement("/resources/item"), ctx);
        assert.equal(remote.content, "remote resource");
        assert.equal(calls, 1);

        const output = await handler.read(readStatement("/1/1/1"), ctx);
        assert.equal(output.status, 404, "an unclaimed output coordinate uses the standard stream reader");
        assert.equal(calls, 1, "the resource facet never intercepts output coordinates");
    } finally {
        await db.close();
    }
});
