// Integration coverage for previously-untagged SPEC.md contract anchors that
// concentrate around the mimetype seam: matcher soft-fallback (§matcher-dispatch),
// compose-pattern (§slice-semantics), 410 channel-delete
// (§send-dispatch), the Mimetypes.process entry point (§mimetype-methods), and the write-time vs
// render-time handler firing boundary (§mimetype — schemes do not invoke handlers).
//
// Vehicles are the real production paths:
//   - §matcher-dispatch / §slice-semantics — Known.read matcher dispatch (Matcher.matchAgainstContent → 203)
//                     + Log.read structural <L> compose over the matcher result.
//   - §send-dispatch — _entry-send.sendToSessionEntry 410-with-fragment over Engine.dispatch.
//   - §mimetype-methods / §mimetype — Mimetypes.process shape + a spy handler proving write (detect)
//                 never fires preview, but render (manifest build → process) does.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    EditStatement, MatcherBody, ParsedPath, PlurnkStatement, ReadStatement, SendStatement,
} from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Known from "../../src/schemes/Known.ts";
import Log from "../../src/schemes/Log.ts";
import File from "../../src/schemes/File.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import {
    openMigrated, insertSession, insertRun, insertLoop, insertTurn,
    seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES,
} from "./_helpers.ts";
import { urlPath, editStmt, readStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `cm-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, sessionId, runId, mimetypes };
};

// --- §matcher-dispatch matcher 203 soft-fallback ---------------------------------------
// jsonpath against a `.json` entry whose body is malformed JSON: the json
// handler's parseTree fails → QueryParseFailureError → Matcher.matchAgainstContent
// maps to 203, returning the RAW bytes as the text primitive plus `reason`.

test("[§matcher-dispatch-203-soft-fallback] jsonpath on malformed-JSON entry returns 203 with raw bytes as text/markdown + reason", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        const k = new Known();
        const broken = '{"host": "db.internal", "pool":}';  // trailing-colon: not valid JSON
        await k.edit(editStmt(urlPath("known", "/config.json"), broken), makeSchemeCtx({ db, sessionId, runId, mimetypes }));

        const r = await k.read(
            readStmt(urlPath("known", "/config.json")) as ReadStatement & { body: MatcherBody },
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        // read() above has no body matcher; re-issue WITH the jsonpath body.
        const matched = await k.read(
            { ...readStmt(urlPath("known", "/config.json")), body: { dialect: "jsonpath", raw: "$.host" } as MatcherBody },
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(r.status, 200, "plain READ of the entry still works");

        assert.equal(matched.status, 203, "parse failure is a soft 203, not a hard 4xx");
        // Soft fallback hands the model the unparsed source verbatim...
        assert.equal(matched.content, broken);
        // ...as the text primitive (never application/json — there is no structure)...
        assert.equal(matched.mimetype, "text/markdown");
        // ...with a reason so the model knows WHY it got raw bytes.
        assert.equal(typeof (matched as { reason?: string }).reason, "string");
        assert.ok(((matched as { reason?: string }).reason ?? "").length > 0, "reason explains the parse failure");
    } finally { await db.close(); }
});

// --- §slice-semantics killer composition: matcher-then-<L> ----------------------------
// Dispatch a regex matcher READ through the Engine (lands at log:///1/1/1 as
// an application/json result), then structural <L><P> over that log entry
// picks the P-th match — matcher rx is application/json, <L> selects the item.

test("[§slice-semantics-compose-pattern] <<READ(log:///1/1/1)<P>::READ picks the P-th match from a prior matcher result", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, runId, 1, "compose");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await new Known().edit(
            editStmt(urlPath("known", "/log.txt"), "error: alpha\nok: beta\nerror: gamma"),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );

        // Matcher READ through the engine → result lands at log:///1/1/1.
        await engine.dispatch({
            statement: {
                ...readStmt(urlPath("known", "/log.txt")),
                body: { dialect: "regex", raw: "/error: (\\w+)/g", pattern: "error: (\\w+)", flags: "g" } as MatcherBody,
            },
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });

        // Sanity: the full matcher result has both error matches as JSON.
        const whole = await new Log().read(readStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({ db, runId, mimetypes }));
        assert.equal(whole.status, 200);
        assert.equal(whole.mimetype, "text/markdown");
        assert.equal((whole.content ?? "").split("\n").length, 2, "two error lines matched");

        // Compose: structural <L><2> over the matcher result → 2nd match line only.
        const picked = await new Log().read(
            { ...readStmt(urlPath("log", "/1/1/1")), lineMarker: { first: 2, last: null } },
            makeSchemeCtx({ db, runId, mimetypes }),
        );
        assert.equal(picked.status, 200);
        assert.equal((picked.content ?? "").split("\n").length, 1, "<L><2> selects exactly the P-th line");
        // §matcher-result: a single anonymous capture group extracts as a one-element
        // array, JSON-encoded as ["gamma"] for the 2nd match.
        assert.match(picked.content ?? "", /\["gamma"\]/);
        assert.doesNotMatch(picked.content ?? "", /alpha/);
    } finally { await db.close(); }
});

// --- §send-dispatch SEND[410](path#fragment) deletes only the named channel ----------
// Multi-channel entry: 410 with a #fragment must delete exactly that channel
// and leave the other channel (and the entry row) intact.

test("SEND[410](path#fragment) deletes only the named channel; siblings remain (side-effect; not model-facing)", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-410-${crypto.randomUUID()}`);
        const { sessionId, runId, loopId, turnId } = env;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Seed a two-channel entry directly (production Known is single-channel;
        // the 410-fragment path is channel-generic, so seed both channels).
        const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "known", pathname: "/multi",
        });
        const entryId = entry!.id;
        await (db.test_seed_channel as PrepMethod).run({ entry_id: entryId, name: "body", content: "keep me", mimetype: "text/plain", state: "static" });
        await (db.test_seed_channel as PrepMethod).run({ entry_id: entryId, name: "summary", content: "delete me", mimetype: "text/plain", state: "static" });

        const r = await engine.dispatch({
            statement: sendStmt(410, urlPath("known", "/multi", "summary")) as SendStatement,
            sessionId, runId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(r.status, 200, "410 on an existing channel succeeds");

        // Entry row survives.
        const stillThere = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "/multi" });
        assert.ok(stillThere !== undefined, "entry row remains — fragment delete is channel-scoped");
        // Named channel is gone.
        const summary = await (db.test_get_channel as PrepMethod).get<{ name: string }>({ entry_id: entryId, name: "summary" });
        assert.equal(summary, undefined, "the named #summary channel was deleted");
        // Sibling channel untouched.
        const body = await (db.test_get_channel as PrepMethod).get<{ name: string; content: string }>({ entry_id: entryId, name: "body" });
        assert.ok(body !== undefined, "sibling #body channel survives");
        assert.equal(body?.content, "keep me", "sibling content is intact — ONLY the named channel was removed");
    } finally { await db.close(); }
});

// --- §mimetype-methods Mimetypes.process is the projection entry point -------------------
// process(input, { channels }) returns the structural projections + extent
// ({ mimetype, ok, totalLines, symbols?/deepJson?/deepXml? }) — no preview
// post-0.15. Assert the shape against the real auto-discovered service for a
// known mimetype (markdown → symbols) and an unknown one (ok:false).

test("[§mimetype-methods-process-entry-point] Mimetypes.process returns the structural projections + extent", async () => {
    const md = "# Title\n\nbody paragraph\n\n## Sub\n\nmore";
    const known = await DEFAULT_MIMETYPES.process({ content: md, hint: "text/markdown" }, { channels: ["symbols"] });
    assert.equal(known.mimetype, "text/markdown", "process echoes the resolved mimetype");
    assert.equal(known.ok, true, "ok:true when a handler produced the projection");
    assert.ok(known.totalLines > 0, "totalLines reports the content extent");
    assert.notEqual(known.symbols, undefined, "the requested symbols channel is populated");

    // Unknown mimetype: no handler → ok:false (no throw, no projection).
    const unknown = await DEFAULT_MIMETYPES.process({ content: "weird-bytes", hint: "application/x-unregistered" });
    assert.equal(unknown.mimetype, "application/x-unregistered", "hint survives even with no handler");
    assert.equal(unknown.ok, false, "ok:false signals the handler-miss");
});

// --- §mimetype schemes do NOT invoke mimetype handlers at write time --------------
// A spy handler instrumented on preview/query. Writing (Known.edit) resolves
// the mimetype via Mimetypes.detect — it must NOT fire the handler. Rendering
// (the manifest build → Mimetypes.process) MUST fire it. Same handler, two
// phases: 0 firings after write, >0 after render.

test("[§mimetype-schemes-do-not-invoke-handlers] write resolves mimetype without firing the handler; render fires it", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-fire-${crypto.randomUUID()}`);
        const { sessionId, runId, loopId } = env;

        const previewCalls: string[] = [];
        const queryCalls: string[] = [];
        const BaseHandler = (await import("@plurnk/plurnk-mimetypes")).BaseHandler;
        class SpyHandler extends BaseHandler {
            // The render path (manifest build → process) always calls extent();
            // overriding it records that the handler fired at render, not write.
            override async extent(content: import("@plurnk/plurnk-mimetypes").HandlerContent): Promise<number> {
                previewCalls.push(typeof content === "string" ? content : "");
                return 1;
            }
            override async query(content: import("@plurnk/plurnk-mimetypes").HandlerContent, dialect: import("@plurnk/plurnk-mimetypes").QueryDialect, pattern: string, flags?: string): Promise<never[]> {
                queryCalls.push(`${dialect}:${pattern}:${flags}`);
                return [];
            }
        }
        // Bind the spy handler to a `.spy` extension so write-time
        // PathMimetype.resolveEntryMimetype({ ext }) → detect resolves text/x-spy and the
        // entry's stored mimetype routes render through the spy. text/* keeps
        // the write off the binary 415 gate (MimetypeBinary.isBinaryMimetype).
        const mimetypes = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map([[".spy", "text/x-spy"]]), byFilename: new Map() },
                handlers: new Map([["text/x-spy", {
                    mimetype: "text/x-spy", glyph: "🕵️", extensions: ["spy"],
                    packageName: "stub://spy", binary: false, source: "package",
                }]]),
            },
            loader: async () => ({ default: SpyHandler }),
        });
        await mimetypes.ready();

        // WRITE phase: Known.edit on a `.spy` path. Resolves mimetype via
        // detect; must not touch preview/query.
        const edited = await new Known().edit(
            editStmt(urlPath("known", "/notes.spy"), "alpha\nbeta\ngamma"),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        assert.equal(edited.status, 201, "write succeeded");
        // Confirm the write resolved the spy mimetype (detect ran, not the handler).
        const channel = await (db.test_get_channel as PrepMethod).get<{ mimetype: string }>({ entry_id: edited.entryId, name: "body" });
        assert.equal(channel?.mimetype, "text/x-spy", "write-time detect resolved the spy mimetype");
        assert.equal(previewCalls.length, 0, "§mimetype: scheme write did NOT invoke the handler's preview");
        assert.equal(queryCalls.length, 0, "§mimetype: scheme write did NOT invoke the handler's query");

        // RENDER phase: a turn assembles the packet; the manifest build routes
        // the spy channel through Mimetypes.process → handler.preview fires.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        const provider = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", ops: [] as PlurnkStatement[], reasoning: null } }],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.ok(previewCalls.length > 0, "§mimetype: render-time manifest build DID invoke the handler's preview");
        assert.ok(previewCalls.includes("alpha\nbeta\ngamma"), "handler saw the stored channel content at render time");
    } finally { await db.close(); }
});
