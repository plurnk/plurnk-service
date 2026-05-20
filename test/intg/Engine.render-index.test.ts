// Render-time mimetype invocation in packet assembly. SPEC §4 + §5.1 + §5.6.
// Engine.#buildIndex pulls (run, entry, channel) tuples with indexed=1 and
// passes each channel's stored content through Mimetypes.process(). With an
// empty discovery (no handlers installed), the framework falls back to
// fitContent — content under budget returns verbatim, which is what these
// tests assert against.

import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Mock from "../../src/providers/Mock.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

// Empty-discovery Mimetypes: no handlers registered, all preview rendering
// flows through fitContent (raw-content fallback). Content under budget
// returns verbatim. Tests installing a real handler (via dep + npm install)
// would exercise the full extract → symbols → preview pipeline.
const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map() },
    tokenize: async (text) => Math.ceil(text.length / 4),
});

const sendStmt = (status: number): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: null,
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
    return JSON.parse(row.packet);
};

const runTurnOnce = async (db: Db, env: { sessionId: number; runId: number; loopId: number }, engine: Engine) => {
    const provider = new Mock({ contextSize: 100000, responses: [response([sendStmt(200)])] });
    return engine.runTurn({ provider, sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, messages: [] });
};

test("[§4-handlers-fire-render-time] Engine invokes mimetype.preview when assembling packet.system.index", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

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
        // Empty-discovery Mimetypes routes through fitContent; small body
        // returns verbatim under the 256-token budget.
        assert.equal(entry.channels.body.content, body);
        assert.equal(entry.channels.body.mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("[§5.1-preview-is-handler-output] each visible channel renders through its own mimetype handler", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

        const md = "# Heading\n\nbody text";
        const plain = "raw\nplain\ntext";
        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "doc",
            channels: [
                { name: "body", content: md, mimetype: "text/markdown" },
                { name: "preview", content: plain, mimetype: "text/plain" },
            ],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);
        const entry = packet.system.index[0];

        // Both channels route through fitContent (empty discovery); each
        // returns its raw content under the 256-token budget.
        assert.equal(entry.channels.body.content, md);
        assert.equal(entry.channels.preview.content, plain);
    } finally { await db.close(); }
});

test("[§5.2-render-filters-by-indexed] hidden channels (indexed=0) do not appear in the index", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

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
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "stream",
            channels: [
                { name: "body", content: "chunk1\nchunk2\n", mimetype: "text/plain", state: "active" },
            ],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index.length, 1);
        assert.equal(packet.system.index[0].channels.body.content, "chunk1\nchunk2\n");
    } finally { await db.close(); }
});

test("empty index when run has no visible channels", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

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
            override async preview(content: string, _budget: number): Promise<string> {
                calls.push(content);
                return `[stub] ${content.slice(0, 10)}`;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map(), byFilename: new Map() },
                handlers: new Map([["application/x-test", {
                    mimetype: "application/x-test", glyph: "🧪", extensions: [],
                    packageName: "stub://test",
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

        assert.equal(calls.length, 1, "handler preview invoked exactly once at render");
        assert.equal(calls[0], "hello-world-and-beyond");
        assert.equal(packet.system.index[0].channels.body.content, "[stub] hello-worl");
    } finally { await db.close(); }
});

test("[§4-handlers-fire-render-time] unknown mimetype falls back to verbatim content (no handler crash)", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

        await seedEntry(db, {
            sessionId: env.sessionId, runId: env.runId, scheme: "known", pathname: "weird",
            channels: [{ name: "body", content: "weird-bytes", mimetype: "application/x-unregistered" }],
        });

        const result = await runTurnOnce(db, env, engine);
        const packet = await readPacket(db, result.turnId);

        assert.equal(packet.system.index[0].channels.body.content, "weird-bytes");
        assert.equal(packet.system.index[0].channels.body.mimetype, "application/x-unregistered");
    } finally { await db.close(); }
});

test("index entries carry tags from entry_tags", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

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
