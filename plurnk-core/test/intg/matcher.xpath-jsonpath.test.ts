// xpath / jsonpath matcher coverage — asserts the matcher contract: status
// mapping, dialect dispatch (through plurnk-mimetypes), and the model-facing
// result shape. A matcher selects a resource; exact READ returns its scoped
// content and reports honest readable-text regions or structural locators.

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import Matcher from "../../src/content/matcher.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "",
    signal: null, target,
    lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, body: MatcherBody | null = null): FindStatement => ({
    op: "FIND", suffix: "",
    signal: null, target,
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const matchLines = (
    matches: ReadonlyArray<any> | undefined,
): number[] => {
    return (matches ?? []).flatMap((match: any) => match.region?.startLine !== undefined ? [match.region.startLine] : []);
};

const matchLocators = (
    matches: ReadonlyArray<any> | undefined,
): string[] => {
    return (matches ?? []).flatMap((match: any) => match.locator !== undefined ? [match.locator] : []);
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `xpjp-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, workspaceId, workerId, mimetypes };
};

const seedJson = async (db: Db, workspaceId: number, workerId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Worker().edit(
        {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("worker", path),
            lineMarker: null, body: content,
            position: { line: 1, column: 1 },
        },
        makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
    );
};

// --- jsonpath -------------------------------------------------------

test("jsonpath: $.host returns its flat match location", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/config.json", '{\n  "host": "db.internal",\n  "pool": 5\n}');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/config.json"), { dialect: "jsonpath", raw: "$.host" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLines(r.results), [2]);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*].name reports each flat match location", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLines(r.results), [3, 4]);
    } finally { await db.close(); }
});

test("jsonpath: $.users[*] returns each selected location", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/team.json"), { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(matchLines(r.results), [3, 4]);
    } finally { await db.close(); }
});

test("jsonpath filter reports non-sequential match coordinates", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" },\n    { "name": "Carol", "role": "admin" }\n  ]\n}');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/team.json"), { dialect: "jsonpath", raw: "$.users[?(@.role=='admin')]" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(matchLines(r.results), [3, 5]);
    } finally { await db.close(); }
});

test("jsonpath: zero matches returns 204 with empty evidence", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/empty.json", '{"users":[]}');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/empty.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 204);
        assert.deepEqual(r.results, []);
    } finally { await db.close(); }
});

test("jsonpath on text/markdown applies against the heading outline (no headings → 204)", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/notes", "not actually json");
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/notes"), { dialect: "jsonpath", raw: "$.field" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(r.status, 204);
        assert.deepEqual(r.results, []);
    } finally { await db.close(); }
});

test("jsonpath on text/markdown queries the marked-AST deepJson", async () => {
    // mimetypes 0.10.0: jsonpath dispatches against deepJson — the marked
    // document AST. `$..text` walks the tree, surfacing every text node.
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/doc.md",
            "# Intro\n\nopening\n\n# Installation\n\nrun npm install\n\n# Usage\n\nhello world\n");
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/doc.md"), { dialect: "jsonpath", raw: "$..text" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.ok(r.results.length > 0);
    } finally { await db.close(); }
});

// --- xpath ----------------------------------------------------------

test("xpath //h1/text(): reports each canonical locator", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/page.html",
            "<html>\n<body>\n<h1>Welcome</h1>\n<p>intro</p>\n<h1>About</h1>\n</body>\n</html>");
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/page.html"), { dialect: "xpath", raw: "//h1/text()" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//h1/text())[1]", "(//h1/text())[2]"]);
    } finally { await db.close(); }
});

test("xpath //user/@email: attribute matches retain canonical locators", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/users.html",
            '<users>\n  <user email="alice@x.com"/>\n  <user email="bob@x.com"/>\n</users>');
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/users.html"), { dialect: "xpath", raw: "//user/@email" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//user/@email)[1]", "(//user/@email)[2]"]);
    } finally { await db.close(); }
});

test("xpath //user node selection returns flat canonical locators", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/page.html",
            "<root>\n  <user>Alice</user>\n  <user>Bob</user>\n</root>");
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/page.html"), { dialect: "xpath", raw: "//user" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//user)[1]", "(//user)[2]"]);
    } finally { await db.close(); }
});

test("xpath predicate reports selected locators without dropping unselected content", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/users.html",
            "<root>\n  <user role='admin'>Alice</user>\n  <user role='viewer'>Bob</user>\n  <user role='admin'>Carol</user>\n</root>");
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/users.html"), { dialect: "xpath", raw: "//user[@role='admin']/text()" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(
            matchLocators(r.results),
            ["(//user[@role='admin']/text())[1]", "(//user[@role='admin']/text())[2]"],
        );
    } finally { await db.close(); }
});

test("xpath on markdown content with no structural match → 204", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, workerId, mimetypes, "/notes", "not html");
        // xpath now runs over the markdown deepXml (any type is queryable); `//h1`
        // matches no heading → zero results, not an unsupported-dialect rejection.
        const r = await new Worker().find(
            findStmt(urlPath("worker", "/notes"), { dialect: "xpath", raw: "//h1" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 204);
    } finally { await db.close(); }
});

// --- Composition with structural <L> ---------------------------------

test("jsonpath match coordinates support a model-chosen surgical follow-up READ", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, workerId, 1, "compose-jsonpath");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await seedJson(db, workspaceId, workerId, mimetypes, "/team.json",
            '[\n  { "name": "Alice" },\n  { "name": "Bob" },\n  { "name": "Carol" }\n]');

        await engine.dispatch({
            statement: {
                op: "FIND", suffix: "", signal: null,
                target: urlPath("worker", "/team.json"),
                lineMarker: null,
                body: { dialect: "jsonpath", raw: "$[*].name" } as MatcherBody,
                position: { line: 1, column: 1 },
            },
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        const findRes = await new Worker().find(
            findStmt(urlPath("worker", "/team.json"), { dialect: "jsonpath", raw: "$[*].name" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(findRes.status, 200);
        const matches = findRes.results as Array<{ region?: { startLine: number; startColumn: number; endLine: number; endColumn: number } }>;
        assert.equal(matches.length, 3);

        const bob = matches[1]!;
        assert.ok(bob.region !== undefined);
        const surgical = await lookThroughScheme("worker", null,
            {
                ...readStmt(urlPath("worker", "/team.json")),
                lineMarker: {
                    marks: [
                        bob.region.startLine,
                        bob.region.startColumn,
                        bob.region.endLine,
                        bob.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(surgical.status, 200);
        assert.match(surgical.content ?? "", /Bob/);
        assert.doesNotMatch(surgical.content ?? "", /Alice|Carol/);
    } finally { await db.close(); }
});

test("an exact matcher FIND stores canonical locators as flat evidence", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, workerId, 1, "sig");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedJson(db, workspaceId, workerId, mimetypes, "/team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        const result = await engine.dispatch({
            statement: findStmt(urlPath("worker", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const finds = rows.filter((r) => r.op === "FIND");
        const res = JSON.parse(finds[0]!.rx) as {
            results: Array<{ locator?: string }>;
        };
        assert.deepEqual(
            res.results.map(({ locator }) => locator),
            ["$['users'][0]['name']", "$['users'][1]['name']"],
            "canonical coordinates distinguish hits that share a source line",
        );
    } finally { await db.close(); }
});

test("Matcher.matchCandidates runs ONE matcher over candidates keyed by ANY identity — a pathname OR a log coordinate", async () => {
    const mimetypes = new Mimetypes(); await mimetypes.ready();
    const candidates = [
        { key: "worker:///a.md", content: "the engine is fast", mimetype: "text/markdown" },
        { key: "1/2/3", content: "no match on this log row", mimetype: "text/markdown" },   // a log coordinate key
        { key: "worker:///b.md", content: "engine tuning notes", mimetype: "text/markdown" },
    ];
    const r = await Matcher.matchCandidates({ dialect: "regex", raw: "/engine/", pattern: "engine", flags: "" } as MatcherBody, candidates, mimetypes);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches.map((m) => m.key), ["worker:///a.md", "worker:///b.md"], "hits keyed by the caller's own identity — the matcher never cares whether it's an entry pathname or a log coordinate");
});

test("Matcher.matchCandidates omits unsupported resources without poisoning a heterogeneous search", async () => {
    const mimetypes = new Mimetypes(); await mimetypes.ready();
    const matcher = { dialect: "regex", raw: "/needle/", pattern: "needle", flags: "" } as MatcherBody;
    const mixed = await Matcher.matchCandidates(matcher, [
        { key: "README.md", content: "the needle is here", mimetype: "text/markdown" },
        { key: "image.bin", content: "", mimetype: "application/octet-stream" },
    ], mimetypes);
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.matches.map(({ key }) => key), ["README.md"]);

    const unsupported = await Matcher.matchCandidates(matcher, [
        { key: "image.bin", content: "", mimetype: "application/octet-stream" },
    ], mimetypes);
    assert.equal(unsupported.status, 415);
    assert.equal(
        unsupported.problem?.type,
        "https://problems.plurnk.dev/schemes/matcher/unsupported-dialect",
    );
    assert.equal(unsupported.problem?.mimetype, "application/octet-stream");
});
