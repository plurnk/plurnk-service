// xpath / jsonpath matcher coverage — asserts the matcher contract: status
// mapping, dialect dispatch (through plurnk-mimetypes), and the model-facing
// result shape. READ returns LINES (plurnk.md:31): each result row is the SOURCE
// line at a match, prefixed `N:\t` with the match's source line number — one match
// per line, line numbers NON-SEQUENTIAL when matches scatter through the document.
// A matcher SELECTS the line; it never extracts or re-encodes the projected value.

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

// Each result row is `N:\t<source line>`. rxLines strips the prefix to the line text;
// rxLineNos surfaces the N's — non-sequential when matches scatter (the contract's point).
const rxLines = (content: string | null | undefined): string[] =>
    (content ?? "").split("\n").map((line) => line.replace(/^\d+:\t/, ""));
const rxLineNos = (content: string | null | undefined): number[] =>
    (content ?? "").split("\n").map((line) => Number(/^(\d+):\t/.exec(line)?.[1] ?? -1));

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

test("jsonpath: $.host returns the SOURCE LINE at the match — not the extracted value", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/config.json", '{\n  "host": "db.internal",\n  "pool": 5\n}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/config.json"), { dialect: "jsonpath", raw: "$.host" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        // host sits on source line 2 — READ delivers that whole line, not the bare value "db.internal".
        assert.deepEqual(rxLineNos(r.content), [2]);
        assert.match(rxLines(r.content)[0], /^\s*"host": "db\.internal",$/);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*].name returns one SOURCE LINE per match", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        // each name sits on its own source line (3, 4) — READ returns those lines, in order.
        assert.deepEqual(rxLineNos(r.content), [3, 4]);
        assert.match(rxLines(r.content)[0], /"name": "Alice"/);
        assert.match(rxLines(r.content)[1], /"name": "Bob"/);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*] returns each matched object's SOURCE LINE (not a JSON re-encode)", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // an object match selects the line it sits on — the verbatim source, not a re-serialized value.
        assert.deepEqual(rxLineNos(r.content), [3, 4]);
        assert.deepEqual(rxLines(r.content), [
            '    { "name": "Alice", "role": "admin" },',
            '    { "name": "Bob", "role": "viewer" }',
        ]);
    } finally { await db.close(); }
});

test("jsonpath filter `$.users[?(@.role=='admin')]`: skipped non-matches → NON-SEQUENTIAL line numbers", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" },\n    { "name": "Carol", "role": "admin" }\n  ]\n}');
        const r = await new Known().read(
            readStmt(urlPath("known", "/team.json"), { dialect: "jsonpath", raw: "$.users[?(@.role=='admin')]" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // Bob (line 4, viewer) is filtered out → the returned source-line numbers jump 3 → 5.
        assert.deepEqual(rxLineNos(r.content), [3, 5]);
        const lines = rxLines(r.content);
        assert.match(lines[0], /"name": "Alice"/);
        assert.match(lines[1], /"name": "Carol"/);
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

test("xpath //h1/text(): returns each heading's SOURCE LINE, non-sequential across the page", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<html>\n<body>\n<h1>Welcome</h1>\n<p>intro</p>\n<h1>About</h1>\n</body>\n</html>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//h1/text()" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        // the <p> on line 4 is skipped → the h1 source lines are 3 and 5.
        assert.deepEqual(rxLineNos(r.content), [3, 5]);
        assert.deepEqual(rxLines(r.content), ["<h1>Welcome</h1>", "<h1>About</h1>"]);
    } finally { await db.close(); }
});

test("xpath //user/@email: an attribute match returns its element's SOURCE LINE", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/users.html",
            '<users>\n  <user email="alice@x.com"/>\n  <user email="bob@x.com"/>\n</users>');
        const r = await new Known().read(
            readStmt(urlPath("known", "/users.html"), { dialect: "xpath", raw: "//user/@email" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // the match is the attribute, but READ delivers the LINE the element sits on (2, 3).
        assert.deepEqual(rxLineNos(r.content), [2, 3]);
        assert.match(rxLines(r.content)[0], /email="alice@x\.com"/);
        assert.match(rxLines(r.content)[1], /email="bob@x\.com"/);
    } finally { await db.close(); }
});

test("xpath //user node selection: returns the element's SOURCE LINE, not a re-serialized node", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/page.html",
            "<root>\n  <user>Alice</user>\n  <user>Bob</user>\n</root>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/page.html"), { dialect: "xpath", raw: "//user" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // Selecting the ELEMENT node returns its verbatim source line — the deep-xml pk: position
        // bookkeeping (plurnk-mimetypes#12) never reaches the model because READ delivers the LINE,
        // not the daughter's re-serialized node.
        assert.deepEqual(rxLineNos(r.content), [2, 3]);
        assert.deepEqual(rxLines(r.content), ["  <user>Alice</user>", "  <user>Bob</user>"]);
    } finally { await db.close(); }
});

test("xpath predicate //user[@role='admin']: matching lines returned, viewer line skipped", async () => {
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        await seedJson(db, sessionId, runId, mimetypes, "/users.html",
            "<root>\n  <user role='admin'>Alice</user>\n  <user role='viewer'>Bob</user>\n  <user role='admin'>Carol</user>\n</root>");
        const r = await new Known().read(
            readStmt(urlPath("known", "/users.html"), { dialect: "xpath", raw: "//user[@role='admin']/text()" } as MatcherBody),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );

        assert.equal(r.status, 200);
        // Bob (viewer, line 3) fails the predicate → returned lines are 2 and 4.
        assert.deepEqual(rxLineNos(r.content), [2, 4]);
        assert.match(rxLines(r.content)[0], /Alice/);
        assert.match(rxLines(r.content)[1], /Carol/);
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

// --- Composition with structural <L> on log:/// ----------------------

test("jsonpath compose-chain: matcher-then-<L> picks the Nth match from log:///", async () => {
    // End-to-end the killer composition: dispatch a jsonpath matcher READ
    // through the engine, then <<READ(log:///N/M/K)<2>::READ to pick the 2nd
    // match line. One match per source line is what makes <L> paging work — so
    // the seed is multi-line (single-line JSON would collapse every match to one row).
    const { db, sessionId, runId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, runId, 1, "compose-jsonpath");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await seedJson(db, sessionId, runId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');

        // Dispatch the matcher READ — lands at log:///1/1/1.
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
            ...readStmt(urlPath("log", "/1/1/1")),
            lineMarker: { marks: [2] },
        };
        const r = await new Log().read(stmt, makeSchemeCtx({ db, runId, mimetypes }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /Bob/);
        assert.doesNotMatch(r.content ?? "", /Alice|Carol/);
    } finally { await db.close(); }
});
