// NETWORK-gated web functionality (the `live` tier — deliberately run, never CI; non-deterministic,
// specific-thing tests, not e2e stories). Proves the boot-DISCOVERED web stack works end-to-end:
//   - http://  (@plurnk/plurnk-schemes-http) — a real fetch, no API key.
//   - exec[search] (@plurnk/plurnk-execs-search) — a real SearXNG query using
//     the operator's normal environment.
//
// NO-MOCK: the http test dispatches a parsed READ straight through a real Engine against the real
// http scheme and real network, then inspects the canonical entry. Nothing is mocked — no
// provider, no db mock, no model turn. The search test fires through the daemon.
//
//  - http: a finite GET writes its complete canonical representation before READ returns 200;
//    genuine event streams retain the subscription lifecycle ({§scheme-subscriptions}).
//  - search: REQUIRED in this tier. An unavailable endpoint fails the live gate.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import Http from "@plurnk/plurnk-schemes-http";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "../intg/_helpers.ts";

// A stable NON-HTML URL: text/plain uses raw fetch (an HTML target routes through the
// HTTP scheme's generic acquisition path, which is exercised separately).
const HTTP_URL = "https://www.google.com/robots.txt";

test("live web: a discovered http:// READ atomically materializes a real URL (no model, no mock)",
    async () => {
        // grammar requires a PLAN lead; PLAN-prefix then take the READ (the service parses ops this way too).
        const parsed = PlurnkParser.parse(`# PLAN1\n\n## READ1 (${HTTP_URL})`);
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

test("live web: exec[search] queries a real SearXNG instance into a results entry (no model, no mock)",
    async () => {
        assert.ok(
            process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL?.trim(),
            "live search coverage requires PLURNK_EXECS_SEARCH_SEARXNG_URL in the operator environment",
        );
        // search is an EXEC runtime (in-tree exec scheme + ctx.executors), effect="read" → auto-runs,
        // streaming its SearXNG JSON into the `results` channel of a search:/// output entry. We dispatch
        // a real EXEC[search] through a real Engine + ExecutorRegistry and read the results back — no mock.
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        try {
            const exec = schemes.get("exec") as Exec;
            const executors = await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: process.cwd() });
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            engine.setExecutors(executors);
            schemes.registerRuntimeSchemes(executors);   // mint the search:// output scheme
            const workspaceId = await insertWorkspace(db, `web-search-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "search");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const parsed = PlurnkParser.parse("# PLAN1\n\n## EXEC1 [search]\nplurnk agent runtime");
            const item = parsed.items.find((i: { kind: string; statement?: PlurnkStatement }) => i.kind === "statement" && i.statement?.op === "EXEC") as { statement: PlurnkStatement } | undefined;
            if (item === undefined) throw new Error("parse produced no statement");

            let logEntryId = -1;
            await engine.dispatch({
                statement: item.statement, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id: number) => { logEntryId = id; },
            });
            await exec.idle();   // the backgrounded search spawn settles

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "search", pathname });
            assert.ok(entry, "a search:/// output entry was created");
            const results = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "results" });
            const rows = JSON.parse(results?.content ?? "[]") as Array<{ url?: string; materialized?: boolean }>;
            assert.ok(Array.isArray(rows) && rows.length > 0, "the SearXNG query returned a non-empty JSON results array");
            const survivor = rows.find((row) => row.materialized === true && typeof row.url === "string");
            assert.ok(survivor?.url, "live search materialized at least one discovered page");
            const url = new URL(survivor.url);
            const page = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
                scheme: url.protocol.slice(0, -1),
                pathname: `/${url.hostname}${url.pathname}`,
            });
            assert.ok(page, "the materialized verdict names a real, addressable web entry");
            const pageBody = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: page.id, name: "body" });
            assert.ok((pageBody?.content.length ?? 0) > 0, "the discovered page has a non-empty model-facing body");
            assert.notEqual(pageBody?.mimetype, "text/html", "raw HTML never occupies the decisive body channel");
        } finally { await schemes.close(); await db.close(); }
    });

test("live web: a real HTML READ stores Tavily Markdown + source HTML under one absolute identity",
    async () => {
        assert.ok(
            process.env.TAVILY_API_KEY?.trim(),
            "live HTML coverage requires TAVILY_API_KEY in the operator environment",
        );
        const parsed = PlurnkParser.parse("# PLAN1\n\n## READ1 (https://example.com/)");
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
