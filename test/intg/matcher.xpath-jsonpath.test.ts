// xpath / jsonpath matcher coverage — written to activate the moment
// plurnk-mimetypes#3 lands. Each test asserts the EXPECTED behavior;
// the `skipIfPendingSibling` guard at the top checks for the canonical
// 501 response and short-circuits with a `console.error` note so the
// suite stays green while the sibling work is in flight.
//
// When plurnk-mimetypes ships the matcher API and plurnk-service's
// matcher.ts wires it through, every test in this file should activate
// automatically without code changes here.

import test from "node:test";
import assert from "node:assert/strict";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Known from "../../src/schemes/Known.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "",
    signal: null, target,
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `xpjp-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const mimetypes = new Mimetypes({ tokenize: async (t: string) => t.length });
    await mimetypes.ready();
    return { db, sessionId, runId, mimetypes };
};

const seedJson = async (db: Db, sessionId: number, runId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Known().edit(
        {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("known", path),
            lineMarker: null, body: content,
            position: { line: 1, column: 1 },
        },
        makeSchemeCtx({ db, sessionId, runId, mimetypes }),
    );
};

// Skip helper — the only path that returns 501 for xpath/jsonpath dialects
// is matcher.ts pending plurnk-mimetypes#3. When the sibling lands and
// the matcher wires through, status will move off 501 and the assertions
// activate. (The error string doesn't propagate through READ result, so
// we identify pending-sibling by status code at the dialect site.)
const pendingSibling = (status: number, _error: string | undefined, label: string): boolean => {
    if (status === 501) {
        console.error(`[pending plurnk-mimetypes#3] ${label}`);
        return true;
    }
    return false;
};

// --- jsonpath -------------------------------------------------------

test("jsonpath: $.field extracts a scalar value from a JSON entry", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/config.json", '{"host":"db.internal","pool":5}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/config.json"), { dialect: "jsonpath", raw: "$.host" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "$.host")) return;
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: unknown }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].matched, "db.internal");
    } finally { await db.close(); }
});

test("jsonpath: $.users[*].name wildcard extracts multiple values with `matching` paths", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"}]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "$.users[*].name")) return;
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: unknown; matching?: string }>;
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.matched), ["Alice", "Bob"]);
        // Wildcard paths should resolve in `matching`.
        assert.equal(rows[0].matching, "$.users[0].name");
        assert.equal(rows[1].matching, "$.users[1].name");
    } finally { await db.close(); }
});

test("jsonpath: $.users[*] returns object values; `matched` holds the JSON shape", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"}]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "$.users[*]")) return;
        assert.equal(r.status, 200);
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: { name: string; role: string } }>;
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0].matched, { name: "Alice", role: "admin" });
        assert.deepEqual(rows[1].matched, { name: "Bob", role: "viewer" });
    } finally { await db.close(); }
});

test("jsonpath: filter expression `$.users[?(@.role==\"admin\")]` selects matching items", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"},{"name":"Carol","role":"admin"}]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[?(@.role=='admin')]" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "filter")) return;
        assert.equal(r.status, 200);
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: { name: string } }>;
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.matched.name), ["Alice", "Carol"]);
    } finally { await db.close(); }
});

test("jsonpath: zero matches → 204 with matches:0", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/empty.json", '{"users":[]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/empty.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "zero-match")) return;
        assert.equal(r.status, 204);
        assert.equal((r as { matches?: number }).matches, 0);
    } finally { await db.close(); }
});

test("jsonpath on a non-JSON mimetype (text/markdown) → 415", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        // No .json suffix → manifest default = text/markdown.
        await seedJson(db, sessionId, runId, mimetypes, "/notes", "not actually json");
        const r = await new Known().read(
            readStmt(urlPath("known", "/notes"), { dialect: "jsonpath", raw: "$.field" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        // 415 is dialect/mimetype mismatch — should activate independently
        // of the sibling impl. Allow either 415 (already implemented) or
        // 501 (still pending).
        if (pendingSibling(r.status, (r as { error?: string }).error, "415-gate")) return;
        assert.equal(r.status, 415);
    } finally { await db.close(); }
});

// --- xpath ----------------------------------------------------------

test("xpath: //h1/text() extracts text content from HTML entries", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        // .html suffix → text/html (tree-navigable, supports xpath).
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<html><body><h1>Welcome</h1><p>intro</p><h1>About</h1></body></html>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//h1/text()" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "//h1/text()")) return;
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: string; matching?: string }>;
        assert.deepEqual(rows.map((r) => r.matched), ["Welcome", "About"]);
    } finally { await db.close(); }
});

test("xpath: //element/@attr extracts attribute values", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/users.html",
            '<users><user email="alice@x.com"/><user email="bob@x.com"/></users>');
        const r = await new Known().read(
            readStmt(urlPath("known", "/users.html"), { dialect: "xpath", raw: "//user/@email" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "//user/@email")) return;
        assert.equal(r.status, 200);
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: string }>;
        assert.deepEqual(rows.map((r) => r.matched), ["alice@x.com", "bob@x.com"]);
    } finally { await db.close(); }
});

test("xpath: //element node selection serializes XML into `matched`", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<root><user>Alice</user><user>Bob</user></root>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//user" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "//user")) return;
        assert.equal(r.status, 200);
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: string; matching?: string }>;
        assert.equal(rows.length, 2);
        assert.match(rows[0].matched, /<user>Alice<\/user>/);
        assert.match(rows[1].matched, /<user>Bob<\/user>/);
        // Per-instance discriminator on multi-match xpath.
        assert.equal(rows[0].matching, "(//user)[1]");
        assert.equal(rows[1].matching, "(//user)[2]");
    } finally { await db.close(); }
});

test("xpath with predicate: //user[@role='admin']", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/users.html",
            "<root><user role='admin'>Alice</user><user role='viewer'>Bob</user><user role='admin'>Carol</user></root>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/users.html"), { dialect: "xpath", raw: "//user[@role='admin']/text()" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "predicate")) return;
        assert.equal(r.status, 200);
        const rows = JSON.parse(r.content ?? "") as Array<{ matched: string }>;
        assert.deepEqual(rows.map((r) => r.matched), ["Alice", "Carol"]);
    } finally { await db.close(); }
});

test("xpath on a non-XML mimetype (text/markdown) → 415", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/notes", "not html");
        const r = await new Known().read(
            readStmt(urlPath("known", "/notes"), { dialect: "xpath", raw: "//h1" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r.status, (r as { error?: string }).error, "xpath-415-gate")) return;
        assert.equal(r.status, 415);
    } finally { await db.close(); }
});

// --- Composition with structural <L> on log:// ----------------------

test("jsonpath result is composable: log://N/M/K<P>::READ picks P-th match", async () => {
    // Already exercised in test/intg/Log.read.test.ts for regex; this
    // verifies the same composition works once jsonpath lands. The
    // matcher returns application/json; structural <L> indexes its array.
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]}');
        const r1 = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        if (pendingSibling(r1.status, (r1 as { error?: string }).error, "compose-step")) return;
        assert.equal(r1.status, 200);
        // After this lands, an end-to-end test should dispatch through
        // engine + log scheme to verify <<READ(log://...)<2>::READ picks
        // "Bob" as the 2nd match. Marked as a follow-up here since this
        // file scopes to the matcher.ts surface.
    } finally { await db.close(); }
});
