// xpath / jsonpath matcher coverage — asserts the EXPECTED behavior
// against the matcher contract. These tests are expected to FAIL until
// plurnk-mimetypes#3 lands and matcher.ts wires the dialect dispatch
// through; the suite carrying red here is the honest signal that the
// dialects aren't wired yet. When the sibling lands, every test in this
// file activates with no code change here.

import test from "node:test";
import assert from "node:assert/strict";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import Log from "../../src/schemes/Log.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

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

// --- jsonpath -------------------------------------------------------

test("jsonpath: $.field extracts a scalar value from a JSON entry", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/config.json", '{"host":"db.internal","pool":5}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/config.json"), { dialect: "jsonpath", raw: "$.host" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

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

        assert.equal(r.status, 204);
        assert.equal((r as { matches?: number }).matches, 0);
    } finally { await db.close(); }
});

test("jsonpath on a non-JSON mimetype (text/markdown) → 415", async () => {
    // Mimetype-mismatch gate already lives in matcher.ts ahead of the
    // sibling-pending 501; this test passes today and should continue
    // passing after the sibling lands.
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/notes", "not actually json");
        const r = await new Known().read(
            readStmt(urlPath("known", "/notes"), { dialect: "jsonpath", raw: "$.field" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
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

        assert.equal(r.status, 415);
    } finally { await db.close(); }
});

// --- Composition with structural <L> on log:// ----------------------

test("jsonpath compose-chain: matcher-then-<L> picks the Nth match from log://", async () => {
    // End-to-end the killer composition: dispatch a jsonpath matcher
    // READ through the engine, then dispatch <<READ(log://N/M/K)<2>::READ
    // to pick the 2nd match. Mirrors the regex version in Log.read.test.ts.
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, runId, 1, "compose-jsonpath");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]}');

        // Dispatch the matcher READ — lands at log://1/1/1.
        await engine.dispatch({
            statement: {
                op: "READ", suffix: "", signal: null,
                target: urlPath("known", "/team.json"),
                lineMarker: null,
                body: { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
                position: { line: 1, column: 1 },
            },
            sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        // Now structural <L><2> on the log entry — should return the 2nd
        // match (Bob) as a single-element JSON array.
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "1/1/1")),
            lineMarker: { first: 2, last: null },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId, mimetypes }));
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        const items = JSON.parse(r.content ?? "") as Array<{ matched: string }>;
        assert.equal(items.length, 1);
        assert.equal(items[0].matched, "Bob");
    } finally { await db.close(); }
});
