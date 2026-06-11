// xpath / jsonpath matcher coverage — asserts the matcher contract: status
// mapping, dialect dispatch (through plurnk-mimetypes), and the model-facing
// result shape. Results render as `N:\t<value>` lines (text/markdown) — one
// match per line, value bare for a single-line string and JSON-encoded
// otherwise; the resolved-path is internal and not surfaced to the model.

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

// Split a `N:\t<value>` result into its values (text after each tab).
const rxValues = (content: string | null | undefined): string[] =>
    (content ?? "").split("\n").map((line) => line.replace(/^\d+:\t/, ""));

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `xpjp-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const mimetypes = new Mimetypes();
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
        assert.equal(r.mimetype, "text/markdown");
        assert.match(r.content ?? "", /^\d+:\tdb\.internal$/);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*].name wildcard extracts multiple values, one per line", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"}]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.deepEqual(rxValues(r.content), ["Alice", "Bob"]);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*] returns object values JSON-encoded on one line each", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"}]}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(rxValues(r.content), [
            '{"name":"Alice","role":"admin"}',
            '{"name":"Bob","role":"viewer"}',
        ]);
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
        const values = rxValues(r.content);
        assert.equal(values.length, 2);
        assert.match(values[0], /"name":"Alice"/);
        assert.match(values[1], /"name":"Carol"/);
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

test("jsonpath on text/markdown applies against the heading outline (no headings → 204)", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/notes", "not actually json");
        const r = await new Known().read(
            readStmt(urlPath("known", "/notes"), { dialect: "jsonpath", raw: "$.field" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(r.status, 204);
        assert.equal(r.matches, 0);
    } finally { await db.close(); }
});

test("jsonpath on text/markdown queries the marked-AST deepJson", async () => {
    // mimetypes 0.10.0: jsonpath dispatches against deepJson — the marked
    // document AST. `$..text` walks the tree, surfacing every text node.
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/doc.md",
            "# Intro\n\nopening\n\n# Installation\n\nrun npm install\n\n# Usage\n\nhello world\n");
        const r = await new Known().read(
            readStmt(urlPath("known", "/doc.md"), { dialect: "jsonpath", raw: "$..text" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        const content = r.content ?? "";
        assert.match(content, /Intro/);
        assert.match(content, /Installation/);
        assert.match(content, /Usage/);
    } finally { await db.close(); }
});

// --- xpath ----------------------------------------------------------

test("xpath: //h1/text() extracts text content from HTML entries", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<html><body><h1>Welcome</h1><p>intro</p><h1>About</h1></body></html>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//h1/text()" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.deepEqual(rxValues(r.content), ["Welcome", "About"]);
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
        assert.deepEqual(rxValues(r.content), ["alice@x.com", "bob@x.com"]);
    } finally { await db.close(); }
});

test("xpath: //element node selection serializes XML into the value", { todo: "blocked on plurnk-mimetypes#12 — deepXml line/endLine bookkeeping pollutes serialization" }, async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<root><user>Alice</user><user>Bob</user></root>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//user" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // todo (plurnk-mimetypes#12): the deepXml's inline line/endLine bookkeeping
        // pollutes element serialization, so the value is currently
        // `<user line="1" endLine="1">Alice</user>`. We assert the clean intended
        // form — stripping the bookkeeping is the daughter's job, not ours.
        const values = rxValues(r.content);
        assert.equal(values.length, 2);
        assert.match(values[0], /<user>Alice<\/user>/);
        assert.match(values[1], /<user>Bob<\/user>/);
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
        assert.deepEqual(rxValues(r.content), ["Alice", "Carol"]);
    } finally { await db.close(); }
});

test("xpath on markdown content with no structural match → 204", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/notes", "not html");
        // xpath now runs over the markdown deepXml (any type is queryable); `//h1`
        // matches no heading → zero results, not an unsupported-dialect rejection.
        const r = await new Known().read(
            readStmt(urlPath("known", "/notes"), { dialect: "xpath", raw: "//h1" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 204);
    } finally { await db.close(); }
});

// --- Composition with structural <L> on log:// ----------------------

test("jsonpath compose-chain: matcher-then-<L> picks the Nth match from log://", async () => {
    // End-to-end the killer composition: dispatch a jsonpath matcher READ
    // through the engine, then <<READ(log://N/M/K)<2>::READ to pick the 2nd
    // match line. One match per line is what makes <L> paging work.
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

        // Structural <L><2> on the log entry — picks the 2nd match line (Bob).
        const stmt: ReadStatement = {
            ...readStmt(urlPath("log", "1/1/1")),
            lineMarker: { first: 2, last: null },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId, mimetypes }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /Bob/);
        assert.doesNotMatch(r.content ?? "", /Alice|Carol/);
    } finally { await db.close(); }
});
