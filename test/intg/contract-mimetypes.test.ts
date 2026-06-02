// Integration coverage for previously-untagged SPEC.md contract anchors that
// concentrate around the mimetype seam: matcher soft-fallback (§16.1),
// compose-pattern (§16.3), EDIT diff surfacing (§16.8), 410 channel-delete
// (§3.5), the Mimetypes.process entry point (§4.2), and the write-time vs
// render-time handler firing boundary (§4 — schemes do not invoke handlers).
//
// Vehicles are the real production paths:
//   - §16.1 / §16.3 — Known.read matcher dispatch (matchAgainstContent → 203)
//                     + Log.read structural <L> compose over the matcher result.
//   - §16.8 — _entry-ops.editSessionEntry / File.edit EDIT result `diff`.
//   - §3.5 — _entry-send.sendToSessionEntry 410-with-fragment over Engine.dispatch.
//   - §4.2 / §4 — Mimetypes.process shape + a spy handler proving write (detect)
//                 never fires preview, but render (#buildIndex.process) does.

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
import { renderSystemContent } from "../../src/core/packet-wire.js";
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
    const mimetypes = new Mimetypes({ tokenize: async (t: string) => t.length });
    await mimetypes.ready();
    return { db, sessionId, runId, mimetypes };
};

// --- §16.1 matcher 203 soft-fallback ---------------------------------------
// jsonpath against a `.json` entry whose body is malformed JSON: the json
// handler's parseTree fails → QueryParseFailureError → matchAgainstContent
// maps to 203, returning the RAW bytes as the text primitive plus `reason`.

test("[§16.1-203-soft-fallback] jsonpath on malformed-JSON entry returns 203 with raw bytes as text/markdown + reason", async () => {
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

// --- §16.3 killer composition: matcher-then-<L> ----------------------------
// Dispatch a regex matcher READ through the Engine (lands at log://1/1/1 as
// an application/json result), then structural <L><P> over that log entry
// picks the P-th match — matcher rx is application/json, <L> selects the item.

test("[§16.3-compose-pattern] <<READ(log://1/1/1)<P>::READ picks the P-th match from a prior matcher result", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, runId, 1, "compose");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await new Known().edit(
            editStmt(urlPath("known", "/log.txt"), "error: alpha\nok: beta\nerror: gamma"),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );

        // Matcher READ through the engine → result lands at log://1/1/1.
        await engine.dispatch({
            statement: {
                ...readStmt(urlPath("known", "/log.txt")),
                body: { dialect: "regex", raw: "/error: (\\w+)/g", pattern: "error: (\\w+)", flags: "g" } as MatcherBody,
            },
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });

        // Sanity: the full matcher result has both error matches as JSON.
        const whole = await new Log().read(readStmt(urlPath("log", "1/1/1")), makeSchemeCtx({ db, runId, mimetypes }));
        assert.equal(whole.status, 200);
        assert.equal(whole.mimetype, "application/json");
        const all = JSON.parse(whole.content ?? "[]") as Array<{ matched: string }>;
        assert.equal(all.length, 2, "two error lines matched");

        // Compose: structural <L><2> over the matcher result → 2nd match only.
        const picked = await new Log().read(
            { ...readStmt(urlPath("log", "1/1/1")), lineMarker: { first: 2, last: null } },
            makeSchemeCtx({ db, runId, mimetypes }),
        );
        assert.equal(picked.status, 200);
        assert.equal(picked.mimetype, "application/json", "<L> on a JSON matcher result preserves structure");
        // §16.2: a single anonymous capture group extracts as a one-element
        // array `[c1]`, so the 2nd match's `matched` is ["gamma"].
        const items = JSON.parse(picked.content ?? "[]") as Array<{ matched: string[] }>;
        assert.equal(items.length, 1, "<L><2> selects exactly the P-th element");
        assert.deepEqual(items[0].matched, ["gamma"], "2nd error match is the gamma capture");
    } finally { await db.close(); }
});

// --- §16.8 EDIT result surfaces a unified diff -----------------------------
// Contract: "Both `_entry-ops.editSessionEntry` and `File.edit` produce it."
// File.edit is asserted here directly (proposal path). editSessionEntry is
// asserted via Known.edit — the contract requires `diff` on its EDIT@200.

test("[§16.8-edit-diff] File.edit surfaces a unified diff on the EDIT result; no-op edit omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-cm-"));
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `cm-file-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: root });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, sessionId, runId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
        };
        await writeFile(join(root, "notes.md"), "alpha\nbeta\ngamma\n");

        // Replace line 2 (beta → BETA): content changes → diff present.
        const changed = await new File().edit(
            { ...editStmt(urlPath("file", "notes.md"), "BETA"), lineMarker: { first: 2, last: null } } as EditStatement,
            ctx,
        );
        assert.equal(changed.status, 202, "File.edit returns a proposal (202)");
        const diff = (changed as { diff?: string }).diff;
        assert.equal(typeof diff, "string", "diff present when content changed");
        assert.match(diff ?? "", /^---|^\+\+\+|@@/m, "diff is unified-diff format");
        assert.match(diff ?? "", /-beta/, "removed line shows in the diff");
        assert.match(diff ?? "", /\+BETA/, "added line shows in the diff");

        // No-op edit (line 2 replaced with its own value): diff omitted.
        const noop = await new File().edit(
            { ...editStmt(urlPath("file", "notes.md"), "beta"), lineMarker: { first: 2, last: null } } as EditStatement,
            ctx,
        );
        assert.equal(noop.status, 202);
        assert.equal((noop as { diff?: string }).diff, undefined, "no-op edit omits the diff (content unchanged)");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("[§16.8-edit-diff] editSessionEntry (Known.edit) surfaces a unified diff on EDIT@200", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "/doc"), "alpha\nbeta\ngamma"), makeSchemeCtx({ db, sessionId, runId }));
        // Replace line 2 — content changes, so the contract requires a diff
        // on the EDIT@200 result (symmetric with File.edit).
        const r = await k.edit(
            { ...editStmt(urlPath("known", "/doc"), "BETA"), lineMarker: { first: 2, last: null } } as EditStatement,
            makeSchemeCtx({ db, sessionId, runId }),
        );
        assert.equal(r.status, 200);
        const diff = (r as { diff?: string }).diff;
        assert.equal(typeof diff, "string", "§16.8: editSessionEntry must produce a diff on its EDIT result");
        assert.match(diff ?? "", /-beta/, "removed line shows in the diff");
        assert.match(diff ?? "", /\+BETA/, "added line shows in the diff");
    } finally { await db.close(); }
});

// The RESULT-side diff (two tests above) is necessary but not sufficient: the
// contract's other half is that the diff reaches the MODEL via the packet-wire
// log render, under the edited entry's fence, so a wrong-marker mistake is
// visible next turn without a follow-up READ. This drives a real EDIT through
// Engine.runTurn (Mock-supplied op → dispatch → #writeLog stores the result's
// `diff` in the rx column), then renders the NEXT turn's stored packet through
// the exact wire path (renderSystemContent → renderLogEntries) and asserts the
// unified-diff `-old`/`+new` lines surface in the System Log.

test("[§16.8-edit-diff] packet-wire log render surfaces the EDIT diff to the model under the fence", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `cm-wire-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "edit-diff-render");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        // Existing known:// entry the EDIT acts on. Seed the content directly
        // so the line-marker replace below is a real EDIT@200 (not a create).
        await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "known", pathname: "doc",
        });
        const entryRow = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "doc" });
        await (db.test_seed_channel as PrepMethod).run({
            entry_id: entryRow!.id, name: "body", content: "alpha\nbeta\ngamma\n", mimetype: "text/markdown", state: "static",
        });
        await (db.test_seed_visibility as PrepMethod).run({
            run_id: runId, entry_id: entryRow!.id, channel: "body", indexed: 1,
        });

        // Turn 1: the model emits EDIT<2>(known://doc) replacing `beta` → `BETA`.
        // dispatch → editSessionEntry → EDIT@200 with `diff` → #writeLog stores
        // the whole result (diff included) in log_entries.rx.
        const editOp: EditStatement = {
            ...editStmt(urlPath("known", "doc"), "BETA"),
            lineMarker: { first: 2, last: null },
        } as EditStatement;
        const turn1Provider = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [editOp] } }],
        });
        await engine.runTurn({ provider: turn1Provider, sessionId, runId, loopId, messages: [] });

        // Turn 2: the prior EDIT is now part of the run's log snapshot. A no-op
        // SEND[200] just advances the turn so its packet is built + stored with
        // the EDIT log row present.
        const turn2Provider = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });
        const turn2 = await engine.runTurn({ provider: turn2Provider, sessionId, runId, loopId, messages: [] });

        // Render turn 2's stored packet through the SAME path the wire uses
        // (packetToWireMessages → renderSystemContent). The System Log section
        // must carry the unified diff under the EDIT entry's fence.
        const packetRow = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turn2.turnId });
        const packet = JSON.parse(packetRow!.packet);
        const rendered = renderSystemContent(packet.system);

        assert.match(rendered, /# Plurnk System Log/, "log section is present in the rendered system content");
        // The model's own EDIT statement is mirrored back...
        assert.match(rendered, /<<EDIT[^]*BETA[^]*:EDIT/, "the model's EDIT statement is re-emitted");
        // ...and the diff fence + unified-diff lines render under it.
        assert.match(rendered, /<<:::diff:\/\//, "diff renders under a diff:// fence");
        assert.match(rendered, /-beta/, "removed line surfaces in the rendered log");
        assert.match(rendered, /\+BETA/, "added line surfaces in the rendered log");
    } finally { await db.close(); }
});

// --- §3.5 SEND[410](path#fragment) deletes only the named channel ----------
// Multi-channel entry: 410 with a #fragment must delete exactly that channel
// and leave the other channel (and the entry row) intact.

test("[§3.5-410-fragment-channel-delete] SEND[410](path#fragment) deletes only the named channel; siblings remain", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-410-${crypto.randomUUID()}`);
        const { sessionId, runId, loopId, turnId } = env;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Seed a two-channel entry directly (production Known is single-channel;
        // the 410-fragment path is channel-generic, so seed both channels).
        const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "known", pathname: "multi",
        });
        const entryId = entry!.id;
        await (db.test_seed_channel as PrepMethod).run({ entry_id: entryId, name: "body", content: "keep me", mimetype: "text/plain", state: "static" });
        await (db.test_seed_channel as PrepMethod).run({ entry_id: entryId, name: "summary", content: "delete me", mimetype: "text/plain", state: "static" });

        const r = await engine.dispatch({
            statement: sendStmt(410, urlPath("known", "multi", "summary")) as SendStatement,
            sessionId, runId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(r.status, 200, "410 on an existing channel succeeds");

        // Entry row survives.
        const stillThere = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "multi" });
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

// --- §4.2 Mimetypes.process is the packet-assembly entry point --------------
// process(input, options) returns { mimetype, preview, ok } (plus totalLines /
// previewTokens). Assert the documented shape against the real auto-discovered
// service for both a known mimetype (markdown → outline preview) and an
// unknown one (empty preview, ok:false).

test("[§4.2-process-entry-point] Mimetypes.process returns { mimetype, preview, ok }", async () => {
    const md = "# Title\n\nbody paragraph\n\n## Sub\n\nmore";
    const known = await DEFAULT_MIMETYPES.process({ content: md, hint: "text/markdown" }, { budget: 256 });
    assert.equal(known.mimetype, "text/markdown", "process echoes the resolved mimetype");
    assert.equal(typeof known.preview, "string", "preview is a string");
    assert.equal(known.ok, true, "ok:true when a handler produced the preview");
    assert.ok(known.preview.includes("Title"), "markdown preview carries the heading outline");

    // Unknown mimetype: no handler → empty preview, ok:false (no throw).
    const unknown = await DEFAULT_MIMETYPES.process({ content: "weird-bytes", hint: "application/x-unregistered" }, { budget: 256 });
    assert.equal(unknown.mimetype, "application/x-unregistered", "hint survives even with no handler");
    assert.equal(unknown.preview, "", "no handler → empty preview, not a crash");
    assert.equal(unknown.ok, false, "ok:false signals the handler-miss");
});

// --- §4 schemes do NOT invoke mimetype handlers at write time --------------
// A spy handler instrumented on preview/query. Writing (Known.edit) resolves
// the mimetype via Mimetypes.detect — it must NOT fire the handler. Rendering
// (Engine #buildIndex → Mimetypes.process) MUST fire it. Same handler, two
// phases: 0 firings after write, >0 after render.

test("[§4-schemes-do-not-invoke-handlers] write resolves mimetype without firing the handler; render fires it", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-fire-${crypto.randomUUID()}`);
        const { sessionId, runId, loopId } = env;

        const previewCalls: string[] = [];
        const queryCalls: string[] = [];
        const BaseHandler = (await import("@plurnk/plurnk-mimetypes")).BaseHandler;
        class SpyHandler extends BaseHandler {
            override async preview(content: import("@plurnk/plurnk-mimetypes").HandlerContent): Promise<import("@plurnk/plurnk-mimetypes").Preview> {
                previewCalls.push(typeof content === "string" ? content : "");
                return { kind: "symbols", symbols: [{ name: "[spy]", kind: "module", line: 1, endLine: 1 }] };
            }
            override async query(content: string, dialect: string, pattern: string, flags: string): Promise<never[]> {
                queryCalls.push(`${dialect}:${pattern}:${flags}`);
                return [];
            }
        }
        // Bind the spy handler to a `.spy` extension so write-time
        // resolveEntryMimetype({ ext }) → detect resolves text/x-spy and the
        // entry's stored mimetype routes render through the spy. text/* keeps
        // the write off the binary 415 gate (isBinaryMimetype).
        const mimetypes = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map([[".spy", "text/x-spy"]]), byFilename: new Map() },
                handlers: new Map([["text/x-spy", {
                    mimetype: "text/x-spy", glyph: "🕵️", extensions: ["spy"],
                    packageName: "stub://spy", binary: false,
                }]]),
            },
            loader: async () => ({ default: SpyHandler }),
            tokenize: async (t: string) => Math.ceil(t.length / 4),
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
        assert.equal(previewCalls.length, 0, "§4: scheme write did NOT invoke the handler's preview");
        assert.equal(queryCalls.length, 0, "§4: scheme write did NOT invoke the handler's query");

        // RENDER phase: a turn assembles the packet; #buildIndex routes the
        // spy channel through Mimetypes.process → handler.preview fires.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        const provider = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", ops: [] as PlurnkStatement[], reasoning: null } }],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.ok(previewCalls.length > 0, "§4: render-time #buildIndex DID invoke the handler's preview");
        assert.ok(previewCalls.includes("alpha\nbeta\ngamma"), "handler saw the stored channel content at render time");
    } finally { await db.close(); }
});
