// Render-time mimetype invocation in packet assembly. SPEC §4 + §5.1 + §5.6.
// Engine.#buildIndex pulls (run, entry, channel) tuples with indexed=1 and
// passes each channel's stored content through Mimetypes.process(). The
// framework owns the preview pipeline: detect → handler → validate →
// extract symbols → fit to budget. Per plurnk-mimetypes 0.6.0 (sibling #2),
// there is no raw-content fallback — handlers without symbols produce an
// empty preview, and unknown mimetypes (no handler discovered) produce
// `{ ok: false, preview: "" }`. The engine writes whatever `result.preview`
// the framework returns into the channel's content slot, no transformation.
//
// These tests assert the engine's plumbing, not the framework's preview
// rendering — the auto-discovering Mimetypes from _helpers.ts loads the
// real per-mimetype siblings (text-markdown, text-plain, etc.) so the
// content seen at the channel slot is the production-shape preview.

import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, DEFAULT_MIMETYPES } from "./_helpers.ts";

// Pre-compute the framework's preview for a given (content, hint) pair so
// tests can assert engine plumbing without hard-coding handler-specific
// output shapes. Whatever Mimetypes.process emits IS the expected channel
// content — the engine's contract is "plumb result.preview through unchanged."
const expectedPreview = async (content: string, hint: string): Promise<string> => {
    const r = await DEFAULT_MIMETYPES.process({ content, hint }, { budget: 256 });
    return r.preview;
};

const sendStmt = (status: number): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: "", json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]) => ({
    assistant: { content: "", ops, reasoning: null },
});

const seedEntry = async (
    db: Db,
    {
        sessionId, runId, scheme, pathname, channels, hidden = false,
    }: {
        sessionId: number; runId: number; scheme: string; pathname: string;
        channels: Array<{ name: string; content: string; mimetype: string; state?: string }>;
        hidden?: boolean;
    },
): Promise<number> => {
    const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
        session_id: sessionId, scheme, pathname,
    });
    if (entry === undefined) throw new Error("seedEntry: insert returned no row");
    for (const c of channels) {
        await (db.test_seed_channel as PrepMethod).run({
            entry_id: entry.id, name: c.name, content: c.content, mimetype: c.mimetype, state: c.state ?? "static",
        });
        await (db.test_seed_visibility as PrepMethod).run({
            run_id: runId, entry_id: entry.id, channel: c.name, indexed: hidden ? 0 : 1,
        });
    }
    return entry.id;
};

const readPacket = async (db: Db, turnId: number): Promise<{
    system: { index: Array<{ id: number; pathname: string; channels: Record<string, { content: string; mimetype: string }>; tags: string[] }> };
}> => {
    const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
    if (row === undefined) throw new Error("readPacket: turn not found");
    const packet = JSON.parse(row.packet);
    // plurnk://manifest.json is a real, always-present entry the engine writes
    // every turn; these tests assert #buildIndex's per-channel plumbing on the
    // seeded entries, so drop the catalog row to keep the assertions focused.
    packet.system.index = packet.system.index.filter((e: { pathname: string }) => e.pathname !== "manifest.json");
    return packet;
};

const runTurnOnce = async (db: Db, env: { sessionId: number; runId: number; loopId: number }, engine: Engine) => {
    const provider = new Mock({ contextSize: 100000, responses: [response([sendStmt(200)])] });
    return engine.runTurn({ provider, sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, messages: [] });
};

test("[§4-handlers-fire-render-time] Engine invokes mimetype.preview when assembling packet.system.index", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const body = "# Title\n\nSome paragraph.\n\n## Sub\n\nMore.";
        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "x",
            channels: [{ name: "body", content: body, mimetype: "text/markdown" }],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index.length, 1);
        const entry = packet.system.index[0];
        assert.equal(entry.pathname, "x");
        // Engine plumbs Mimetypes.process(...).preview into the channel slot.
        // For text/markdown, the framework's preview is the heading outline
        // (not the raw body) — assert against the framework's own output.
        assert.equal(entry.channels.body.content, await expectedPreview(body, "text/markdown"));
        assert.equal(entry.channels.body.mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("[§5.1-preview-is-handler-output] each visible channel renders through its own mimetype handler", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const md = "# Heading\n\nbody text";
        const plain = "raw\nplain\ntext";
        // Synthetic multi-channel entry — production schemes today are
        // single-channel; this exercises the render-path's per-channel
        // mimetype dispatch in advance of multi-channel schemes (exec,
        // http) landing.
        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "doc",
            channels: [
                { name: "body", content: md, mimetype: "text/markdown" },
                { name: "summary", content: plain, mimetype: "text/plain" },
            ],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);
        const entry = packet.system.index[0];

        // Per-channel dispatch: each channel's mimetype routes to its own
        // handler. text/markdown produces a heading outline; text/plain has
        // no symbols and produces an empty preview.
        assert.equal(entry.channels.body.content, await expectedPreview(md, "text/markdown"));
        assert.equal(entry.channels.summary.content, await expectedPreview(plain, "text/plain"));
        assert.equal(entry.channels.body.mimetype, "text/markdown");
        assert.equal(entry.channels.summary.mimetype, "text/plain");
    } finally { await db.close(); }
});

test("[§5.2-render-filters-by-indexed] hidden channels (indexed=0) do not appear in the index", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "visible",
            channels: [{ name: "body", content: "shown", mimetype: "text/plain" }],
        });
        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "hidden",
            channels: [{ name: "body", content: "secret", mimetype: "text/plain" }],
            hidden: true,
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index.length, 1);
        assert.equal(packet.system.index[0].pathname, "visible");
    } finally { await db.close(); }
});

test("[§5.6-engine-does-not-branch-on-state] active (mid-stream) channels render their current content", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "stream",
            channels: [
                { name: "body", content: "chunk1\nchunk2\n", mimetype: "text/plain", state: "active" },
            ],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index.length, 1);
        // Engine doesn't branch on channel.state — active and static channels
        // both flow through the same Mimetypes.process call. text/plain has
        // no symbol extraction, so the rendered preview is empty regardless
        // of state. What matters here is that the channel is rendered at all,
        // not what shape its preview takes.
        assert.equal(
            packet.system.index[0].channels.body.content,
            await expectedPreview("chunk1\nchunk2\n", "text/plain"),
        );
    } finally { await db.close(); }
});

test("empty index when run has no visible channels", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.deepEqual(packet.system.index, []);
    } finally { await db.close(); }
});

test("[§4-handlers-fire-render-time] custom mimetype handler is invoked at render time", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);

        // Inject a stub BaseHandler subclass via Mimetypes' loader + discovery
        // options. Engine routes content through Mimetypes.process; framework
        // resolves the handler via the injected loader; our stub returns an
        // identifiable preview the assertion can check.
        const calls: string[] = [];
        const StubHandler = (await import("@plurnk/plurnk-mimetypes")).BaseHandler;
        class TestHandler extends StubHandler {
            override async preview(content: import("@plurnk/plurnk-mimetypes").HandlerContent): Promise<import("@plurnk/plurnk-mimetypes").Preview> {
                calls.push(typeof content === "string" ? content : "");
                return { kind: "symbols", symbols: [{
                    name: `[stub] ${(typeof content === "string" ? content : "").slice(0, 10)}`,
                    kind: "module",
                    line: 1, endLine: 1,
                }] };
            }
        }
        const mimetypes = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map(), byFilename: new Map() },
                handlers: new Map([["application/x-test", {
                    mimetype: "application/x-test", glyph: "🧪", extensions: [],
                    packageName: "stub://test", binary: false, source: "package",
                }]]),
            },
            loader: async (_pkgName) => ({ default: TestHandler }),
            tokenize: async (text) => Math.ceil(text.length / 4),
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "t",
            channels: [{ name: "body", content: "hello-world-and-beyond", mimetype: "application/x-test" }],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        // Fires for both render paths: #buildIndex's preview, and
        // #buildManifestBody re-processing each entry for mimetypes' totalLines
        // — the content's extent is the daughter's to compute, not ours.
        assert.equal(calls.length, 2, "handler preview invoked at render — index + manifest");
        assert.equal(calls[0], "hello-world-and-beyond");
        // Framework renders the returned SymbolPreview into a tree-shaped
        // string: `<kind> <name> [<line>]`. The stub returned one symbol
        // {kind:"module", name:"[stub] hello-worl", line:1} → rendered as
        // "module [stub] hello-worl [1]". Asserts the stub's preview reached
        // the channel; the exact render format is the framework's job.
        const rendered = packet.system.index[0].channels.body.content;
        assert.ok(rendered.includes("[stub] hello-worl"), `expected stub marker in: ${rendered}`);
        assert.ok(rendered.includes("[1]"), `expected line marker in: ${rendered}`);
    } finally { await db.close(); }
});

test("[§4-handlers-fire-render-time] unknown mimetype produces empty preview (no handler crash)", async () => {
    // plurnk-mimetypes 0.6.0 dropped the raw-content fitContent fallback
    // (sibling #2). When no handler is registered for a mimetype,
    // Mimetypes.process returns `{ ok: false, preview: "" }` — the engine
    // plumbs that empty string into the channel content slot. The mimetype
    // and pathname survive the trip, so the channel is still rendered, just
    // with no preview material. No crash, no exception.
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "weird",
            channels: [{ name: "body", content: "weird-bytes", mimetype: "application/x-unregistered" }],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index[0].channels.body.content, "");
        assert.equal(packet.system.index[0].channels.body.mimetype, "application/x-unregistered");
    } finally { await db.close(); }
});

test("index entries carry tags from entry_tags", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const entryId = await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "tagged",
            channels: [{ name: "body", content: "x", mimetype: "text/plain" }],
        });
        await (db.test_seed_entry_tag as PrepMethod).run({ entry_id: entryId, tag: "alpha" });
        await (db.test_seed_entry_tag as PrepMethod).run({ entry_id: entryId, tag: "beta" });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.deepEqual(packet.system.index[0].tags, ["alpha", "beta"]);
    } finally { await db.close(); }
});
