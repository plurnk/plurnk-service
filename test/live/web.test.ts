// NETWORK-gated web functionality (the `live` tier — deliberately run, never CI; non-deterministic,
// specific-thing tests, not e2e stories). Proves the boot-DISCOVERED web stack works end-to-end:
//   - http://  (@plurnk/plurnk-schemes-http) — a real fetch, no API key.
//   - exec[search] (@plurnk/plurnk-execs-search) — a real SearXNG query, gated on its URL.
//
// NO-MOCK: the http test dispatches a parsed READ straight through a real Engine against the real
// http scheme and real network, then polls the REAL db channel for the fetched bytes. Nothing is
// mocked — no provider, no db mock, no model turn. The search test fires through the daemon.
//
// BOTH SKIPPED pending a real BLOCKER, documented per test:
//  - http: the service does NOT yet implement `ctx.subscriptions` (SubscriptionCaps), the streaming
//    capability the scheme contract @plurnk/plurnk-schemes 0.30.8 defines (ctx.d.ts) and the http
//    daughter calls (`ctx.subscriptions.open/.notifyChunk/.close`). Our in-tree exec scheme bypasses
//    it via ChannelWrite directly, so http 500s ("reading 'open'"). Un-skip once the capability lands.
//  - search: needs PLURNK_EXECS_SEARCH_SEARXNG_URL (a SearXNG endpoint; no API key).

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Http from "@plurnk/plurnk-schemes-http";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "../intg/_helpers.ts";

// A stable NON-HTML URL: text/plain streams via raw fetch (an HTML target routes through the
// http scheme's lazy Chromium renderer — a heavier dependency, exercised separately).
const HTTP_URL = "https://www.google.com/robots.txt";

test("live web: a discovered http:// READ fetches a real URL into a streamed entry (no model, no mock)",
    async () => {
        const parsed = PlurnkParser.parse(`<<READ(${HTTP_URL})::READ`);
        const item = parsed.items.find((i: { kind: string }) => i.kind === "statement") as { statement: PlurnkStatement } | undefined;
        if (item === undefined) throw new Error("parse produced no statement");
        const statement = item.statement;
        const db = await openMigrated();
        try {
            // NOTE: register http EXTERNAL (discoverExternal) so the engine wraps its ctx in
            // SchemeCtxImpl — a plain register() makes it in-tree (raw ctx.db, no subscriptions).
            const schemes = new SchemeRegistry();
            await schemes.discoverExternal(process.cwd());
            const engine = new Engine({ db, schemes });
            const sessionId = await insertSession(db, `web-http-${crypto.randomUUID()}`);
            const runId = await insertRun(db, sessionId);
            const loopId = await insertLoop(db, runId, 1, "web");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const r = await engine.dispatch({ statement, sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
            assert.equal(r.status, 102, "http READ backgrounds (102) — the body streams in");

            // Poll the REAL channel until the fetched bytes land (the stream writes it async).
            let body = "";
            for (let i = 0; i < 40 && body.length === 0; i++) {
                await new Promise((res) => setTimeout(res, 500));
                const e = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({ scheme: "https", pathname: "/robots.txt" })
                    ?? await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({ scheme: "http", pathname: "/robots.txt" });
                if (e) body = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: e.id, name: "body" }))?.content ?? "";
            }
            assert.ok(body.length > 0, "the real fetched robots.txt body materialized in the entry");
            assert.match(body, /User-agent|Disallow/i, "the body is the actual robots.txt content");
        } finally { await db.close(); }
    });

test("live web: exec[search] queries a real SearXNG instance",
    { skip: process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL ? "blocked: same ctx.subscriptions gap as http (search streams too)" : "set PLURNK_EXECS_SEARCH_SEARXNG_URL (a SearXNG endpoint) to run" },
    async () => {
        // exec[search] streams its results the same way → same SubscriptionCaps dependency.
        // Fires through op.exec({ runtime: "search", command }) once the capability + a SearXNG URL exist.
        assert.fail("enable once ctx.subscriptions lands and PLURNK_EXECS_SEARCH_SEARXNG_URL is set");
    });
