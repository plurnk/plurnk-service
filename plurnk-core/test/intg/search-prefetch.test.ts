// [§search-prefetch] — search declares web members (#333, owner rulings 2026-07-13). The four
// guard stories from the alignment: parity (a prefetched page is indistinguishable from a
// hand-READ page), no log spam (the sync pass mints no log rows), survivor truth (a dead
// candidate never appears — the render is rebuilt from the entries that exist), and one
// listing (chooser context + live costs together; no synthetic FIND).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Http from "@plurnk/plurnk-schemes-http";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import type { WakeRunPayload } from "../../src/core/ChannelWrite.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

const PARA = "The alpha page body paragraph, repeated to clear the salvage floor and give the renderer real content to keep. ";
const PAGE = `<html><head><title>Alpha</title></head><body><article><h1>Alpha</h1><p>${PARA.repeat(8)}</p></article></body></html>`;

const withFixtureServer = async (fn: (base: string) => Promise<void>): Promise<void> => {
    const server = createServer((req, res) => {
        // text/plain takes the raw streaming path — hermetic (the HTML render path needs a
        // browser binary; that parity belongs to schemes-http's own suite, not this guard).
        if (req.url === "/alpha") { res.writeHead(200, { "content-type": "text/plain" }); res.end(PAGE); return; }
        res.writeHead(404, { "content-type": "text/plain" }); res.end("gone");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try { await fn(`http://127.0.0.1:${port}`); }
    finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
};

const seed = async (db: Awaited<ReturnType<typeof openMigrated>>, base: string) => {
    const sessionId = await insertSession(db, `prefetch-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "search something");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const schemes = new SchemeRegistry();
    schemes.register("http", new Http());  // the real installed scheme — parity is the point
    // The daemon's wake wiring, minimally: page conclusions route to the orchestrator's
    // waiters (in production Daemon.#handleWakeRun does this before anything else).
    const notifyRef: { fn: (p: WakeRunPayload) => void } = { fn: () => {} };
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES, wakeRunNotify: (p: WakeRunPayload) => notifyRef.fn(p) });
    notifyRef.fn = (p) => { engine.searchPrefetch.ownsConclusion(p); };
    const ctx = await engine.prefetchCtx(sessionId, runId);
    // The exec entry a concluded search stream leaves behind: #results = the candidate digest.
    const candidates = [
        { title: "Alpha", url: `${base}/alpha`, snippet: "the alpha snippet", publishedDate: "2026-07-01" },
        { title: "Dead", url: `${base}/dead`, snippet: "a 404 candidate" },
    ];
    await EntryCrud.writeEntry("/search/1", {
        channels: { "#results": { content: JSON.stringify(candidates), mimetype: "application/json" } },
        tags: [],
    }, ctx, "search");
    const payload: WakeRunPayload = {
        sessionId, runId, entryId: 0, target: "search:///search/1", subscriptionId: 0,
        closeStatus: 200, scheme: "search", summary: "search concluded", loop_seq: 1, turn_seq: 1, sequence: 1,
    };
    return { sessionId, runId, engine, ctx, payload };
};

test("[§search-prefetch] survivors materialize, dead rows vanish, one listing carries context + live costs (#333)", async () => {
    const db = await openMigrated();
    try {
        await withFixtureServer(async (base) => {
            const { sessionId, runId, engine, ctx, payload } = await seed(db, base);
            const logsBefore = await (db.test_count_op as PrepMethod).get<{ n: number }>({ op: "READ" });
            assert.equal(engine.searchPrefetch.isSearchConclusion(payload), true, "a 200 search-runtime conclusion triggers");
            await engine.searchPrefetch.onSearchConcluded(payload, () => engine.prefetchCtx(sessionId, runId));
            assert.equal(engine.searchPrefetch.holds(runId), false, "the pass released the hold leg");

            // Survivor truth: the live page exists as an ordinary http entry; the dead one does not.
            const host = base.replace("http://", "");
            const alpha = await EntryCrud.readEntry(`/${host}/alpha`, ctx, "http");
            assert.ok(alpha.entry !== null && alpha.entry !== undefined, "the live candidate materialized as an http entry");
            assert.ok((alpha.entry?.channels.body?.content.length ?? 0) > 0, "with a rendered body");
            // The dead candidate is excluded from the survivor LISTING (asserted below) — but a
            // fetched 404 leaves a real http entry (its error page), exactly as a hand-READ 404
            // would: parity means the pass doesn't special-case it away. It simply isn't a member,
            // and carries no chooser attributes (never stamped).
            const deadAttrs = await (db.test_get_entry_attributes as PrepMethod).get<{ attributes: string }>({ session_id: sessionId, scheme: "http", pathname: `/${host}/dead` });
            const deadParsed = JSON.parse(deadAttrs?.attributes ?? "{}") as Record<string, unknown>;
            assert.equal(deadParsed.title, undefined, "the dead candidate was never stamped as a survivor");

            // Chooser context on the entry (owner ruling): attributes carry title/snippet/date.
            const attrs = await (db.test_get_entry_attributes as PrepMethod).get<{ attributes: string }>({ session_id: sessionId, scheme: "http", pathname: `/${host}/alpha` });
            const parsed = JSON.parse(attrs?.attributes ?? "{}") as Record<string, unknown>;
            assert.equal(parsed.title, "Alpha", "title stamped on the entry");
            assert.equal(parsed.snippet, "the alpha snippet", "snippet stamped on the entry");

            // One listing: #results rewritten as the survivor render with live costs.
            const rewritten = await EntryCrud.readEntry("/search/1", ctx, "search");
            const digest = JSON.parse(rewritten.entry?.channels["#results"]?.content ?? "[]") as Array<Record<string, unknown>>;
            assert.equal(digest.length, 1, "the render holds exactly the survivors — no dead rows");
            assert.equal(digest[0].url, `${base}/alpha`);
            assert.equal(digest[0].title, "Alpha");
            assert.ok(typeof digest[0].tokens === "number" && (digest[0].tokens as number) > 0, "live token cost rides the row");
            assert.ok(typeof digest[0].lines === "number" && (digest[0].lines as number) > 0, "live line count rides the row");

            // No log spam: the sync pass minted zero log rows (READ or otherwise).
            const logsAfter = await (db.test_count_op as PrepMethod).get<{ n: number }>({ op: "READ" });
            assert.equal(logsAfter?.n, logsBefore?.n, "the pass wrote entries silently — no READ log rows");
        });
    } finally { await db.close(); }
});

test("[§search-prefetch] the pass's page conclusions are swallowed — owned wakes never proceed (#333)", async () => {
    const db = await openMigrated();
    try {
        await withFixtureServer(async (base) => {
            const { sessionId, runId, engine, payload } = await seed(db, base);
            const passDone = engine.searchPrefetch.onSearchConcluded(payload, () => engine.prefetchCtx(sessionId, runId));
            assert.equal(engine.searchPrefetch.holds(runId), true, "the hold leg is up while the pass runs");
            await passDone;
            // After the pass, an unrelated http conclusion is NOT owned (waiters drained).
            const stray: WakeRunPayload = { sessionId, runId, entryId: 0, target: "http://example.org/x", subscriptionId: 9, closeStatus: 200, scheme: "http", summary: "" };
            assert.equal(engine.searchPrefetch.ownsConclusion(stray), false, "ownership is exact — only the pass's own pages are swallowed");
        });
    } finally { await db.close(); }
});
