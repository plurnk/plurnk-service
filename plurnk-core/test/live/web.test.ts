// NETWORK-gated web functionality (the `live` tier — deliberately run, never CI; non-deterministic,
// specific-thing tests, not e2e stories). Proves the boot-DISCOVERED web stack works end-to-end:
//   - http://  (@plurnk/plurnk-schemes-http) — a real fetch, no API key.
//   - Tavily Extract — a real HTML READ when the operator provides TAVILY_API_KEY.
//
// Web discovery is an ordinary MCP attachment ({§web-search-retrieval}); the search-MCP
// live exercise lives with the demo-tier fixture (test/demo).
//
// NO-MOCK: the http test dispatches a parsed READ straight through a real Engine against the real
// http scheme and real network, then inspects the canonical entry. Nothing is mocked — no
// provider, no db mock, no model turn.
//
//  - http: a finite GET writes its complete canonical representation before READ returns 200;
//    genuine event streams retain the subscription lifecycle ({§scheme-subscriptions}).
//  - Tavily: REQUIRED in this tier. An unavailable key fails the live gate.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "../intg/_helpers.ts";

// A stable NON-HTML URL: text/plain uses raw fetch (an HTML target routes through the
// HTTP scheme's generic acquisition path, which is exercised separately).
const HTTP_URL = "https://www.google.com/robots.txt";

test("live web: a discovered http:// READ atomically materializes a real URL (no model, no mock)",
    async () => {
        // grammar requires a PLAN lead; PLAN-prefix then take the READ (the service parses ops this way too).
        const parsed = PlurnkParser.parse(`# PLAN0\n\n## READ0 (${HTTP_URL})`);
        const item = parsed.items.find((i: { kind: string; statement?: PlurnkStatement }) => i.kind === "statement" && i.statement?.op === "READ") as { statement: PlurnkStatement } | undefined;
        if (item === undefined) throw new Error("parse produced no statement");
        const statement = item.statement;
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        try {
            // NOTE: register http EXTERNAL (discoverExternal) so the engine wraps its ctx in
            // SchemeCtxImpl — a plain register() makes it in-tree (raw ctx.db, no subscriptions).
            await schemes.discoverExternal(process.cwd());
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            const workspaceId = await insertWorkspace(db, `web-http-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "web");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const r = await engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
            assert.equal(r.status, 200, "finite HTTP READ settles only after canonical materialization");
            assert.match(String(r.content), /User-agent|Disallow/i, "READ returns the actual robots.txt content");
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "https", pathname: "/www.google.com/robots.txt" });
            assert.ok(entry);
            const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
            assert.ok(body?.content.startsWith(String(r.content)), "READ projects from the stored canonical prefix");
            assert.ok((body?.content.split("\n").length ?? 0) > 16, "the entry retains content beyond the markerless preview");
            assert.deepEqual((r.range as { returned?: readonly number[] } | undefined)?.returned, [1, 16]);
        } finally { await schemes.close(); await db.close(); }
    });

test("live web: a real HTML READ stores Tavily Markdown + source HTML under one absolute identity",
    async () => {
        assert.ok(
            process.env.TAVILY_API_KEY?.trim(),
            "live HTML coverage requires TAVILY_API_KEY in the operator environment",
        );
        const parsed = PlurnkParser.parse("# PLAN0\n\n## READ0 (https://example.com/)");
        const item = parsed.items.find((i: { kind: string; statement?: PlurnkStatement }) => i.kind === "statement" && i.statement?.op === "READ") as { statement: PlurnkStatement } | undefined;
        if (item === undefined) throw new Error("parse produced no READ");
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        try {
            await schemes.discoverExternal(process.cwd());
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            const workspaceId = await insertWorkspace(db, `web-html-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "web html");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const result = await engine.dispatch({ statement: item.statement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
            assert.equal(result.status, 200);
            assert.equal(result.mimetype, "text/markdown");
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "https", pathname: "/example.com/" });
            assert.ok(entry);
            const body = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "body" });
            const html = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "html" });
            const header = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "header" });
            assert.equal(body?.mimetype, "text/markdown");
            assert.match(body?.content ?? "", /documentation examples/i);
            assert.match(body?.content ?? "", /iana\.org\/domains\/example/i);
            assert.equal(html?.mimetype, "text/html");
            assert.match(html?.content ?? "", /<html/i);
            assert.match(html?.content ?? "", /Example Domain/i);
            assert.match(header?.content ?? "", /^x-plurnk-materializer-id: tavily-extract:v1:basic$/m);
            assert.match(header?.content ?? "", /^x-plurnk-tavily-request-id: .+$/m);
            assert.match(header?.content ?? "", /^x-plurnk-tavily-credits: [0-9.]+$/m);
        } finally { await schemes.close(); await db.close(); }
    });
