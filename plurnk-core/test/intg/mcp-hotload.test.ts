// #289 part 1 — the runtime-registration seam behind the /mcp hotload route. Engine.hotloadRuntime
// registers an executor TAG live (an MCP server connected at runtime becomes EXEC[<name>]) on BOTH the
// ExecutorRegistry (dispatch + the tools sheet) and the SchemeRegistry face, sharing boot's arbitration.
// The mcp.install method (the execs-mcp glue over this seam) needs a live MCP server to test end-to-end;
// here we pin the generic seam + its one-name-one-owner arbitration with a stand-in executor.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor, RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import { openMigrated } from "./_helpers.ts";

// A stand-in executor — the seam stores the entry + wraps the executor in a lazy scheme face
// (ExecOutputScheme reads the executor only at dispatch), so registration needs no live runtime.
const fakeEntry = (tag: string): RegistryEntry => ({
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() { return { name: tag } as unknown as never; },
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

test("hotload: Engine.hotloadRuntime registers a live tag on BOTH registries — dispatchable + offered to the model", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.hotloadRuntime("myserver", fakeEntry("myserver"));
        assert.ok(executors.entry("myserver"), "tag in the executor registry — dispatch resolves EXEC[myserver]");
        assert.ok(executors.availableRuntimes().includes("myserver"), "offered to the model on the next packet's tools sheet");
        assert.ok(schemes.has("myserver"), "scheme face registered — READ/FIND/KILL for the tag");
    } finally { await db.close(); }
});

test("hotload: one-name-one-owner — a dup tag AND a reserved built-in name fail-hard, leaving neither registry half-written", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.hotloadRuntime("myserver", fakeEntry("myserver"));

        // Re-registering a live tag is a caller error, not a silent overwrite.
        assert.throws(() => engine.hotloadRuntime("myserver", fakeEntry("myserver")), /already/i, "dup tag rejected");

        // A reserved built-in scheme name (known/exec/run/…) is rejected by the scheme-first arbitration
        // gate — and because the face is registered BEFORE the executor, the executor registry is never
        // touched on a rejected tag (no half-write).
        assert.throws(() => engine.hotloadRuntime("known", fakeEntry("known")), /reserved/i, "reserved name rejected");
        assert.equal(executors.entry("known"), undefined, "reserved collision left the executor registry untouched");
        assert.equal(schemes.get("known")?.constructor.name, "Known", "the reserved 'known' scheme is unchanged, not shadowed");
    } finally { await db.close(); }
});
