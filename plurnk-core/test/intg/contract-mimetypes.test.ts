// Integration coverage for previously-untagged SPEC.md contract anchors that
// concentrate around the mimetype seam: matcher soft-fallback (§matcher-dispatch),
// compose-pattern (§slice-semantics), 410 channel-delete
// (§send-dispatch), the Mimetypes.process entry point (§mimetype-methods), and the write-time vs
// render-time handler firing boundary (§mimetype — schemes do not invoke handlers).
//
// Vehicles are the real production paths:
//   - §matcher-dispatch / §slice-semantics — Known.read matcher dispatch (Matcher.matchAgainstContent → 203)
//                     + Log.read structural <L> compose over the matcher result.
//   - §send-dispatch — _entry-send.sendToWorkspaceEntry 410-with-fragment over Engine.dispatch.
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
import Worker from "../../src/schemes/Worker.ts";
import Log from "../../src/schemes/Log.ts";
import File from "../../src/schemes/File.ts";
import type { Db } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import {
    openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn,
    seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES,
} from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";
import { urlPath, editStmt, readStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `cm-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, workspaceId, workerId, mimetypes };
};

// --- §matcher-dispatch matcher 203 soft-fallback ---------------------------------------
// jsonpath against a `.json` entry whose body is malformed JSON: the json
// handler's parseTree fails → QueryParseFailureError → Matcher.matchAgainstContent
// maps to 203, returning the RAW bytes as the text primitive plus `reason`.

test("jsonpath on malformed-JSON entry returns 203 with raw bytes as text/markdown + reason", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const k = new Worker();
        const broken = '{"host": "db.internal", "pool":}';  // trailing-colon: not valid JSON
        await k.edit(editStmt(urlPath("worker", "/config.json"), broken), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));

        const r = await k.read(
            readStmt(urlPath("worker", "/config.json")) as ReadStatement & { body: MatcherBody },
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        // read() above has no body matcher; re-issue WITH the jsonpath body.
        const matched = await k.read(
            { ...readStmt(urlPath("worker", "/config.json")), body: { dialect: "jsonpath", raw: "$.host" } as MatcherBody },
            makeSchemeCtx({ db, workspaceId, mimetypes }),
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

test("a matcher READ fans out per match — the Nth match is log:///<l>/<t>/N, addressed directly (#286)", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, workerId, 1, "compose");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await new Worker().edit(
            editStmt(urlPath("worker", "/log.txt"), "error: alpha\nok: beta\nerror: gamma"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );

        // Matcher READ through the engine → fans out one row per match (#286).
        const r = await engine.dispatch({
            statement: {
                ...readStmt(urlPath("worker", "/log.txt")),
                body: { dialect: "regex", raw: "/error: (\\w+)/g", pattern: "error: (\\w+)", flags: "g" } as MatcherBody,
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.rowsWritten, 3, "the FIND selection-summary row + two error matches, not one combined blob");

        // The compose pattern under per-match: the Nth match IS log:///<l>/<t>/N — its own
        // addressable row. No <P>-slice of a combined result (there is no combined result). Each
        // row carries its matching LINE (regex SELECTS, never extracts — plurnk.md:31).
        const m1 = await new Log().read(readStmt(urlPath("log", "/1/1/2")), makeSchemeCtx({ db, workerId, mimetypes }));
        const m2 = await new Log().read(readStmt(urlPath("log", "/1/1/3")), makeSchemeCtx({ db, workerId, mimetypes }));
        assert.match(m1.content ?? "", /error: alpha/, "the 1st match is its own row");
        assert.match(m2.content ?? "", /error: gamma/, "the 2nd match is the 2nd row");
        assert.doesNotMatch(m2.content ?? "", /alpha/, "each row holds exactly its own match");
    } finally { await db.close(); }
});

// --- §send-dispatch SEND[410](path#fragment) deletes only the named channel ----------
// Multi-channel entry: 410 with a #fragment must delete exactly that channel
// and leave the other channel (and the entry row) intact.

test("SEND[410](path#fragment) deletes only the named channel; siblings remain (side-effect; not model-facing)", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-410-${crypto.randomUUID()}`);
        const { workspaceId, workerId, loopId, turnId } = env;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Seed a two-channel entry directly (production Known is single-channel;
        // the 410-fragment path is channel-generic, so seed both channels).
        const entry = await db.test_seed_entry_session.get<{ id: number }>({
            workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/multi",
        });
        const entryId = entry!.id;
        await db.test_seed_channel.run({ entry_id: entryId, name: "body", content: "keep me", mimetype: "text/plain", state: "static" });
        await db.test_seed_channel.run({ entry_id: entryId, name: "summary", content: "delete me", mimetype: "text/plain", state: "static" });

        const r = await engine.dispatch({
            statement: sendStmt(410, urlPath("worker", "/multi", "summary")) as SendStatement,
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(r.status, 200, "410 on an existing channel succeeds");

        // Entry row survives.
        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/multi" });
        assert.ok(stillThere !== undefined, "entry row remains — fragment delete is channel-scoped");
        // Named channel is gone.
        const summary = await db.test_get_channel.get<{ name: string }>({ entry_id: entryId, name: "summary" });
        assert.equal(summary, undefined, "the named #summary channel was deleted");
        // Sibling channel untouched.
        const body = await db.test_get_channel.get<{ name: string; content: string }>({ entry_id: entryId, name: "body" });
        assert.ok(body !== undefined, "sibling #body channel survives");
        assert.equal(body?.content, "keep me", "sibling content is intact — ONLY the named channel was removed");
    } finally { await db.close(); }
});

// --- §mimetype-methods Mimetypes.process is the projection entry point -------------------
// process(input, { channels }) returns the structural projections + extent
// ({ mimetype, ok, totalLines, symbols?/deepJson?/deepXml? }) — no preview
// post-0.15. Assert the shape against the real auto-discovered service for a
// known mimetype (markdown → symbols) and an unknown one (ok:false).

test("Mimetypes.process returns the structural projections + extent", async () => {
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

test("write resolves mimetype without firing the handler; render fires it", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-fire-${crypto.randomUUID()}`);
        const { workspaceId, workerId, loopId } = env;

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
        const edited = await new Worker().edit(
            editStmt(urlPath("worker", "/notes.spy"), "alpha\nbeta\ngamma"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(edited.status, 201, "write succeeded");
        // Confirm the write resolved the spy mimetype (detect ran, not the handler).
        const channel = await db.test_get_channel.get<{ mimetype: string }>({ entry_id: edited.entryId, name: "body" });
        assert.equal(channel?.mimetype, "text/x-spy", "write-time detect resolved the spy mimetype");
        assert.equal(previewCalls.length, 0, "§mimetype: scheme write did NOT invoke the handler's preview");
        assert.equal(queryCalls.length, 0, "§mimetype: scheme write did NOT invoke the handler's query");

        // RENDER phase: a turn assembles the packet; the manifest build routes
        // the spy channel through Mimetypes.process → handler.preview fires.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "", ops: [] as PlurnkStatement[], reasoning: null } }],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.ok(previewCalls.length > 0, "§mimetype: render-time manifest build DID invoke the handler's preview");
        assert.ok(previewCalls.includes("alpha\nbeta\ngamma"), "handler saw the stored channel content at render time");
    } finally { await db.close(); }
});

// --- #524 (mimetypes#523) consumer regression: recursive descent over a DEEP parse tree ------
// The prod break: json-p3's default maxRecursionDepth (50) threw InvalidExpressionError on
// `$..x` over any code entry's deepJson (a 2-line file is ~350 nodes) — and matcher.ts maps
// that error class to 400 "malformed matcher", blaming the MODEL for a correct expression.
// Supplier-side fix is unbounded recursion over trusted trees; this pins the CONSUMER contract
// (a $.. READ over a real code entry through the dispatch path succeeds) so a future engine
// swap that reintroduces a depth ceiling fails HERE, loudly, not in a live daemon.
test("recursive-descent jsonpath over a deep code-entry parse tree matches — never a depth-capped 400 (#524)", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const k = new Worker();
        const source = [
            "export function greet(name: string): string {",
            "    const prefix = \"hello\";",
            "    return `${prefix}, ${name}`;",
            "}",
            "export function part(items: string[]): string[] {",
            "    return items.filter((x) => x.length > 0).map((x) => x.trim());",
            "}",
        ].join("\n");
        await k.edit(editStmt(urlPath("worker", "/util.ts"), source), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));

        const matched = await k.read(
            { ...readStmt(urlPath("worker", "/util.ts")), body: { dialect: "jsonpath", raw: "$..*" } as MatcherBody },
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.notEqual(matched.status, 400, `depth cap resurfaced as a model-blamed 400: ${matched.problem?.detail ?? ""}`);
        assert.equal(matched.status, 200, "recursive descent over the full parse tree succeeds");
        assert.ok(typeof matched.content === "string" && matched.content.includes("greet"), "matches carry real tree content (positive presence)");
    } finally { await db.close(); }
});
