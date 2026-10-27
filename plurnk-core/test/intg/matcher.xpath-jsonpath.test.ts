import test, { describe, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import Matcher from "../../src/content/matcher.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Http from "@plurnk/plurnk-schemes-http";
import { type FindStatement, type MatcherBody, type ParsedPath, type ReadStatement, type UrlPath, type KillStatement, type SendStatement, type LocalPath, type LineMarker } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEnvelope, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, DEFAULT_MIMETYPES, mimetypesFixture } from "./_scheme.ts";
import { type MatchItem } from "../../src/schemes/_entry-find.ts";
import { serverProposals } from "./_approval.ts";
import { urlPath, editStmt, killStmt, sendStmt } from "./_dsl.ts";
import { resourcePaths, resourceGroups } from "./_find.ts";
import { type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { fixtureExecutors } from "./_mock.ts";
import { requestUrl } from "../../../scripts/lib/test-fetch.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";

describe("matcher.xpath-jsonpath", () => {
const readStmt = (target: ParsedPath | null): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
 target,
    lineMarker: null, matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, matcher: MatcherBody | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
 target,
    lineMarker: null, matcher, body: null,
     position: { line: 1, column: 1 },
});

// A catalog resource is a tuple; only a match location carries a region or a locator.
const matchLines = (matches: readonly MatchItem[] | undefined): number[] =>
    (matches ?? []).flatMap((match) => !Array.isArray(match) && match.region?.startLine !== undefined ? [match.region.startLine] : []);

const matchLocators = (matches: readonly MatchItem[] | undefined): string[] =>
    (matches ?? []).flatMap((match) => !Array.isArray(match) && match.locator !== undefined ? [match.locator] : []);

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `xpjp-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, workspaceId, sessionId, mimetypes };
};

const seedJson = async (db: Db, workspaceId: number, sessionId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Workspace().edit(
        {
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("workspace", path),
            lineMarker: null, matcher: null, body: content,
            position: { line: 1, column: 1 },
        },
        makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
    );
};

// --- jsonpath -------------------------------------------------------

test("{§matcher-dispatch} jsonpath: $.host returns its flat match location", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/config.json", '{\n  "host": "db.internal",\n  "pool": 5\n}');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/config.json"), { dialect: "jsonpath", raw: "$.host" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLines(r.results), [2]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} jsonpath: $.users[*].name reports each flat match location", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLines(r.results), [3, 4]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} jsonpath: $.users[*] returns each selected location", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" }\n  ]\n}');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/team.json"), { dialect: "jsonpath", raw: "$.users[*]" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(matchLines(r.results), [3, 4]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} jsonpath filter reports non-sequential match coordinates", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/team.json",
            '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob", "role": "viewer" },\n    { "name": "Carol", "role": "admin" }\n  ]\n}');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/team.json"), { dialect: "jsonpath", raw: "$.users[?(@.role=='admin')]" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(matchLines(r.results), [3, 5]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} jsonpath: zero matches returns 204 with empty evidence", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/empty.json", '{"users":[]}');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/empty.json"), { dialect: "jsonpath", raw: "$.users[*].name" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 204);
        assert.deepEqual(r.results, []);
    } finally { await db.close(); }
});

test("{§op-invariants} jsonpath on text/markdown applies against the heading outline (no headings → 204)", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/notes", "not actually json");
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/notes"), { dialect: "jsonpath", raw: "$.field" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(r.status, 204);
        assert.deepEqual(r.results, []);
    } finally { await db.close(); }
});

test("{§mimetype-handler-contract} jsonpath on text/markdown queries the marked-AST deepJson", async () => {
    // mimetypes 0.10.0: jsonpath dispatches against deepJson — the marked
    // document AST. `$..text` walks the tree, surfacing every text node.
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/doc.md",
            "# Intro\n\nopening\n\n# Installation\n\nrun npm install\n\n# Usage\n\nhello world\n");
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/doc.md"), { dialect: "jsonpath", raw: "$..text" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.ok(r.results.length > 0);
    } finally { await db.close(); }
});

// --- xpath ----------------------------------------------------------

test("{§matcher-dispatch} xpath //h1/text(): reports each canonical locator", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/page.html",
            "<html>\n<body>\n<h1>Welcome</h1>\n<p>intro</p>\n<h1>About</h1>\n</body>\n</html>");
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/page.html"), { dialect: "xpath", raw: "//h1/text()" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//h1/text())[1]", "(//h1/text())[2]"]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} xpath //user/@email: attribute matches retain canonical locators", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/users.html",
            '<users>\n  <user email="alice@x.com"/>\n  <user email="bob@x.com"/>\n</users>');
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/users.html"), { dialect: "xpath", raw: "//user/@email" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//user/@email)[1]", "(//user/@email)[2]"]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} xpath //user node selection returns flat canonical locators", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/page.html",
            "<root>\n  <user>Alice</user>\n  <user>Bob</user>\n</root>");
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/page.html"), { dialect: "xpath", raw: "//user" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(matchLocators(r.results), ["(//user)[1]", "(//user)[2]"]);
    } finally { await db.close(); }
});

test("{§matcher-dispatch} xpath predicate reports selected locators without dropping unselected content", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/users.html",
            "<root>\n  <user role='admin'>Alice</user>\n  <user role='viewer'>Bob</user>\n  <user role='admin'>Carol</user>\n</root>");
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/users.html"), { dialect: "xpath", raw: "//user[@role='admin']/text()" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 200);
        assert.deepEqual(
            matchLocators(r.results),
            ["(//user[@role='admin']/text())[1]", "(//user[@role='admin']/text())[2]"],
        );
    } finally { await db.close(); }
});

test("{§matcher-dispatch} xpath on markdown content with no structural match → 204", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        await seedJson(db, workspaceId, sessionId, mimetypes, "/notes", "not html");
        // xpath runs over the markdown deepXml (any type is queryable); `//h1`
        // matches no heading → zero results.
        const r = await new Workspace().find(
            findStmt(urlPath("workspace", "/notes"), { dialect: "xpath", raw: "//h1" }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );

        assert.equal(r.status, 204);
    } finally { await db.close(); }
});

// --- Composition with structural <L> ---------------------------------

test("{§matcher-dispatch} jsonpath match coordinates support a model-chosen surgical follow-up READ", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, sessionId, 1, "compose-jsonpath");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await seedJson(db, workspaceId, sessionId, mimetypes, "/team.json",
            '[\n  { "name": "Alice" },\n  { "name": "Bob" },\n  { "name": "Carol" }\n]');

        await engine.dispatch({
            statement: {
                metadata: null,
                op: "FIND", aside: null,
                target: urlPath("workspace", "/team.json"),
                lineMarker: null,
                matcher: { dialect: "jsonpath", raw: "$[*].name" } as MatcherBody, body: null,
                position: { line: 1, column: 1 },
            },
            workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });

        const findRes = await new Workspace().find(
            findStmt(urlPath("workspace", "/team.json"), { dialect: "jsonpath", raw: "$[*].name" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(findRes.status, 200);
        const matches = findRes.results as Array<{ region?: { startLine: number; startColumn: number; endLine: number; endColumn: number } }>;
        assert.equal(matches.length, 3);

        const bob = matches[1];
        assert.ok(bob.region !== undefined);
        const surgical = await readThroughScheme("workspace", null,
            {
                ...readStmt(urlPath("workspace", "/team.json")),
                lineMarker: {
                    marks: [
                        bob.region.startLine,
                        bob.region.startColumn,
                        bob.region.endLine,
                        bob.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(surgical.status, 200);
        assert.match(surgical.content ?? "", /Bob/);
        assert.doesNotMatch(surgical.content ?? "", /Alice|Carol/);
    } finally { await db.close(); }
});

test("{§find-result-projection} an exact matcher FIND stores canonical locators as flat evidence", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, sessionId, 1, "sig");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedJson(db, workspaceId, sessionId, mimetypes, "/team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        const result = await engine.dispatch({
            statement: findStmt(urlPath("workspace", "/team.json"), { dialect: "jsonpath", raw: "$.users[*].name" }),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const find = rows.find((r) => r.op === "FIND");
        const res = JSON.parse(find!.rx) as {
            results: Array<{ locator?: string }>;
        };
        assert.deepEqual(
            res.results.map(({ locator }) => locator),
            ["$['users'][0]['name']", "$['users'][1]['name']"],
            "canonical coordinates distinguish hits that share a source line",
        );
    } finally { await db.close(); }
});

test("{§find} Matcher.matchCandidates runs ONE matcher over candidates keyed by ANY identity — a pathname OR a log coordinate", async () => {
    const mimetypes = new Mimetypes(); await mimetypes.ready();
    const candidates = [
        { key: "workspace:///a.md", content: "the engine is fast", mimetype: "text/markdown" },
        { key: "1/2/3", content: "no match on this log row", mimetype: "text/markdown" },   // a log coordinate key
        { key: "workspace:///b.md", content: "engine tuning notes", mimetype: "text/markdown" },
    ];
    const r = await Matcher.matchCandidates({ dialect: "regex", raw: "/engine/", pattern: "engine", flags: "" }, candidates, mimetypes);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches.map((m) => m.key), ["workspace:///a.md", "workspace:///b.md"], "hits keyed by the caller's own identity — the matcher never cares whether it's an entry pathname or a log coordinate");
});

test("{§matcher-dispatch} Matcher.matchCandidates omits unsupported resources without poisoning a heterogeneous search", async () => {
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
        "https://problems.plurnk.xyz/schemes/matcher/unsupported-dialect",
    );
    assert.equal(unsupported.problem?.mimetype, "application/octet-stream");
});
});

describe("Engine.whole-line-insert", () => {
beforeEach((t) => serverProposals(t as TestContext, "accept"));

const execFileP = promisify(execFile);
const FILE = "tests/test_ext_autodoc.py";
const LINES = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`);
const BODY = "@pytest.mark.sphinx('html', testroot='ext-autodoc')\ndef test_autodoc_inherited_members_multiple_classes(app):\n    pass";

type Row = { status: number; landed: string | null; inserted: number | null; removed: number | null };

const program = async (frames: (anchor: (line: number) => string) => string[]): Promise<{ rows: Row[]; content: string }> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-whole-line-"));
    const db = await openMigrated();
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await mkdir(dirname(join(root, FILE)), { recursive: true });
        await writeFile(join(root, FILE), `${LINES.join("\n")}\n`);
        await execFileP("git", ["add", "."], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `whole-line-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Add the test.");
        const respond = async (content: string, args: Parameters<Mock["generate"]>[0]) =>
            await new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
        let calls = 0;
        const provider = new Mock({ contextWindow: 100_000, responses: [] });
        provider.generate = async (args) => {
            calls += 1;
            if (calls === 1) return await respond(PlurnkParser.frame(`READ (${FILE}) <790,800>`, null), args);
            if (calls === 2) {
                const row = (await db.engine_render_log.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ session_id: sessionId }))
                    .findLast(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                assert.ok(row, "the model READ the file");
                const anchors = (JSON.parse(row.rx) as { lineAnchors?: string[] }).lineAnchors;
                assert.ok(Array.isArray(anchors) && anchors.length === 11, "the READ published one anchor per line 790..800");
                return await respond(frames((line) => anchors[line - 790]).join("\n\n"), args);
            }
            return await respond(PlurnkParser.frame("SEND [200]", "Done."), args);
        };
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Add the test." }] });
        assert.equal(result.result.status, 200, JSON.stringify(result.result).slice(0, 300));
        const logRows = (await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: id })))).flat();
        const rows = logRows.filter(({ op, origin }) => op === "EDIT" && origin === "model").map(({ status_rx, rx }) => {
            const parsed = JSON.parse(rx) as { receipt?: { effect?: { result?: string; inserted?: number; removed?: number } } };
            return { status: status_rx, landed: parsed.receipt?.effect?.result ?? null, inserted: parsed.receipt?.effect?.inserted ?? null, removed: parsed.receipt?.effect?.removed ?? null };
        });
        return { rows, content: await readFile(join(root, FILE), "utf8") };
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

const edit = (scope: string, body: string): string => PlurnkParser.frame(`EDIT (${FILE}) <${scope}>`, body);

test("{§zero-width-column-one-insert} <795,1,795,1> with a body lacking a trailing newline inserts whole lines before line 795 and removes nothing", async () => {
    const { rows, content } = await program(() => [edit("795,1,795,1", BODY)]);
    assert.deepEqual(rows.map(({ status, removed }) => [status, removed]), [[200, 0]]);
    const lines = content.split("\n");
    assert.equal(lines.length, 804, "800 lines, three inserted, and the trailing split");
    assert.deepEqual(lines.slice(793, 798), ["line 794", ...BODY.split("\n"), "line 795"]);
    assert.equal(rows[0].landed, "<795,1,798,1>", "the receipt lands the three whole lines");
});

test("{§zero-width-column-one-insert} the anchored <@h,1,@h,1> form inserts the same whole lines", async () => {
    const { rows, content } = await program((anchor) => [edit(`${anchor(795)},1,${anchor(795)},1`, BODY)]);
    assert.deepEqual(rows.map(({ status }) => status), [200]);
    assert.deepEqual(content.split("\n").slice(793, 798), ["line 794", ...BODY.split("\n"), "line 795"]);
});

test("{§zero-width-column-one-insert} a zero-width region off column 1 stays byte-exact, and an empty body inserts nothing", async () => {
    const { rows, content } = await program(() => [edit("795,5,795,5", "X"), edit("797,1,797,1", "")]);
    assert.deepEqual(rows.map(({ status }) => status), [200, 304], "an empty body at a zero-width region is a no-op, not a line");
    const lines = content.split("\n");
    assert.equal(lines.length, 801, "no line was added");
    assert.equal(lines[794], "lineX 795", "byte-exact insert inside the line");
    assert.equal(lines[796], "line 797", "the empty body left line 797 alone");
});
});

describe("KILL.entry", () => {
const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; sessionId: number; loopId: number; turnId: number }, statement: SendStatement | KillStatement, sequence = 1) =>
    engine.dispatch({ statement, ...env, sequence, origin: "client" });

test("{§op-invariants} KILL(workspace:///x) deletes the entry (side-effect; not model-facing)", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/doomed"), "tomorrow"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const beforeDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/doomed")));
        assert.equal(r.status, 200);

        const afterDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { await db.close(); }
});

test("{§op-invariants} KILL on missing entry returns 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("{§op-invariants} KILL with #fragment deletes that channel only; entry remains", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/x"), "body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/x", "body")));
        assert.equal(r.status, 200);

        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/x" });
        assert.ok(stillThere !== undefined, "entry row still present");
        const channel = await db.test_get_channel.get<{ name: string }>({ entry_id: stillThere?.id, name: "body" });
        assert.equal(channel, undefined, "body channel was removed");
    } finally { await db.close(); }
});

test("{§op-invariants} KILL with #fragment on missing channel returns 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/y"), "body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/y", "nonexistent")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

// {§op-invariants}
test("{§edit-result-receipt-projection} a scoped KILL deletes one span of an entry through the EDIT path; the log row records the KILL", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), "alpha\nbeta\ngamma"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/notes.md"), { marks: [2] }));
        assert.equal(r.status, 200, `the span deletion lands: ${JSON.stringify(r)}`);
        const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" });
        assert.equal(body?.content, "alpha\ngamma", "exactly the scoped line is gone");
        const row = await db.test_first_log_entry_for_turn.get<{ op: string; lineMarker: string | null }>({ turn_id: turnId });
        assert.equal(row?.op, "KILL", "the receipt is the model's own operation");
        // {§edit-result-receipt-projection} — the deletion receipt quotes what it took.
        const receiptRow = await db.test_first_log_entry_for_turn.get<{ rx: string | null }>({ turn_id: turnId });
        assert.match(String(receiptRow?.rx), /"removedText":"beta"/, `the removed line rides the receipt: ${String(receiptRow?.rx).slice(0, 300)}`);
    } finally { await db.close(); }
});

// {§op-invariants}
test("{§op-invariants} an entry KILL with a pattern deletes exactly the matching spans and records the KILL", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), "alpha\nbeta\ngamma\nbeta again\ndelta"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/beta/", pattern: "beta", flags: "" };
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/notes.md"), null, matcher));
        assert.equal(r.status, 200, `the pattern deletion lands: ${JSON.stringify(r)}`);
        assert.equal(r.matched, 2, "every match counts once");
        const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" });
        assert.equal(body?.content, "alpha\n\ngamma\n again\ndelta", "unmatched text and separators remain");
        const receipt = r.receipt as { effect: { removedText?: string } } | undefined;
        assert.equal(receipt?.effect.removedText, "beta", "the receipt quotes the first span it took");
        const last = r.last as { removedText?: string } | undefined;
        assert.equal(last?.removedText, "beta", "and the last one");
        const row = await db.test_first_log_entry_for_turn.get<{ op: string }>({ turn_id: turnId });
        assert.equal(row?.op, "KILL", "the log row is the model's own operation");
    } finally { await db.close(); }
});

// {§op-invariants} — a scope bounds the lines the pattern may touch; zero matches change nothing.
test("{§op-invariants} a scoped entry KILL with a pattern matches only inside the scope and reports zero matches as 204", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), "alpha\nbeta\ngamma\nbeta again"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const literal: MatcherBody = { dialect: "glob", raw: "beta" };
        const nothing = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/notes.md"), { marks: [3] }, literal));
        assert.equal(nothing.status, 204, `no line in scope matches: ${JSON.stringify(nothing)}`);
        assert.equal(nothing.matched, 0);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\nbeta\ngamma\nbeta again", "nothing was deleted");
        const one = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/notes.md"), { marks: [1, 2] }, literal), 2);
        assert.equal(one.status, 200, `the in-scope match is deleted: ${JSON.stringify(one)}`);
        assert.equal(one.matched, 1);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\n\ngamma\nbeta again", "the out-of-scope match and unmatched separator stay");
    } finally { await db.close(); }
});

// {§op-invariants}
test("{§op-invariants} an entry KILL with a full-text pattern deletes the matching source span", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), "alpha\nbeta"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/notes.md"), null, { dialect: "fts", raw: "~beta" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\n", "only the matched token was deleted");
    } finally { await db.close(); }
});

test("{§op-invariants} a recipient SEND to an entry scheme returns 501 (entry schemes carry no messages)", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/x"), "body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, sendStmt(urlPath("workspace", "/x"), "hello"));
        assert.equal(r.status, 501);
    } finally { await db.close(); }
});

test("{§op-invariants} KILL(workspace:///x) deletes unknown entry", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/topic")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/topic" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("{§op-invariants} KILL cascades to entry channels", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/doomed"), "body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        const entryId = entryRow!.id;
        assert.ok(((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, killStmt(urlPath("workspace", "/doomed")));
        assert.equal(r.status, 200);

        assert.equal((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n, 0);
    } finally { await db.close(); }
});
});

describe("graph.file", () => {
const filePath = (pathname: string): LocalPath => ({ kind: "local", raw: pathname });

const findStmt = (target: LocalPath, matcher: MatcherBody): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker: null, matcher, body: null,
     position: { line: 1, column: 1 },
});

const graph = (raw: string): MatcherBody => ({ dialect: "graph", raw });

// src/a.ts defines foo (calls bar); src/b.ts references foo; src/c.ts defines bar.
const FILES: ReadonlyArray<readonly [string, string]> = [
    ["src/a.ts", "export function foo() {\n  bar();\n}\n"],
    ["src/b.ts", "import { foo } from \"./a\";\nfoo();\n"],
    ["src/c.ts", "export function bar() {}\n"],
];

const seed = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `gfile-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

    // Materialize file entries exactly as git-membership does: writeEntry(scheme="file").
    for (const [pathname, content] of FILES) {
        await EntryCrud.writeEntry({ authority: "", pathname: pathname }, { channels: { body: { content, mimetype: "text/typescript" } } }, ctx, "file");
    }
    // Populate the graph through the pre-model persistent-index pass.
    await SearchIndex.maintain(ctx);
    return { db, workspaceId, sessionId };
};

test("{§matcher-dispatch} &graph resolves over file:/// entries", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });
        // FIND returns channel groups; a stored file resource renders its default path BARE
        // (slash-free, namespace-relative) — the same form the manifest catalogs and the
        // model types back, not the addressed file:/// form.
        const referrers = await new File().find(findStmt(filePath(""), graph("&<foo")), ctx);
        assert.equal(referrers.status, 200);
        assert.deepEqual([...new Set(resourcePaths(referrers))], ["src/b.ts"]);

        const referents = await new File().find(findStmt(filePath(""), graph("&>foo")), ctx);
        assert.deepEqual([...new Set(resourcePaths(referents))], ["src/c.ts"]);

        const definitions = await new File().find(findStmt(filePath(""), graph("&foo")), ctx);
        assert.deepEqual([...new Set(resourcePaths(definitions))], ["src/a.ts"]);
    } finally { db.close(); }
});
});

describe("graph.find", () => {
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const fullReplace: LineMarker = { marks: [1, -1] };
const graphEditStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: marker, body,
    matcher: null, position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, matcher: MatcherBody): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker: null, matcher, body: null,
     position: { line: 1, column: 1 },
});

const graph = (raw: string): MatcherBody => ({ dialect: "graph", raw });

// a.ts defines foo (whose body calls bar); b.ts references foo; c.ts defines bar.
// So: foo's referrers = {b.ts}, foo's referents = {c.ts} (via its call to bar).
const FILES: ReadonlyArray<readonly [string, string]> = [
    ["a.ts", "export function foo() {\n  bar();\n}\n"],
    ["b.ts", "import { foo } from \"./a\";\nfoo();\n"],
    ["c.ts", "export function bar() {}\n"],
];

const seed = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `graph-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const k = new Workspace();
    for (const [pathname, body] of FILES) {
        await k.edit(graphEditStmt(url(pathname), body), makeSchemeCtx({ db, workspaceId, sessionId }));
    }
    // The pre-model persistent-index pass derives graph artifacts from every
    // readable entry. {§persistent-search-index}
    await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, sessionId }));
    return { db, workspaceId, sessionId };
};

const find = (db: Db, workspaceId: number, sessionId: number, raw: string) =>
    new Workspace().find(findStmt(url(""), graph(raw)), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));

test("{§matcher-dispatch} graph FIND reports an incomplete persistent index instead of silently dropping entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `graph-readiness-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await new Workspace().edit(editStmt(url("pending.ts"), "export function pending() {}\n"), ctx);

        const result = await find(db, workspaceId, sessionId, "&pending");

        assert.equal(result.status, 503);
        assert.deepEqual(result.problem?.search, {
            state: "incomplete",
            indexed: 0,
            total: 1,
        });
    } finally { db.close(); }
});

test("{§matcher-dispatch} &<foo finds entries that reference foo, not the definer", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        const r = await find(db, workspaceId, sessionId, "&<foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///b.ts"]);
        assert.equal(resourceGroups(r)[0]?.[0].matchLocationCount, 2, "the broad row counts the import and call locations");
        assert.equal(r.matchLocationCount, 2);
    } finally { db.close(); }
});

test("{§matcher-dispatch} &>foo finds entries defining what foo references", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        const r = await find(db, workspaceId, sessionId, "&>foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///c.ts"]);
    } finally { db.close(); }
});

test("{§matcher-dispatch} &foo selects definitions, not callers or dependencies", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        const r = await find(db, workspaceId, sessionId, "&foo");
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.ts"]);
    } finally { db.close(); }
});

test("{§range-extent}: a graph matcher selecting no resources returns 204 with its empty extent", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        const r = await find(db, workspaceId, sessionId, "&<nope");
        assert.deepEqual(r, {
            status: 204,
            content: null,
            mimetype: null,
            results: [],
            itemsWeightTotal: 0,
            returnedItemsWeightTotal: 0,
            matchingPathCount: 0,
            matchLocationCount: 0,
            range: {
                unit: "resource",
                total: 0,
                requested: [1, PAGE],
            },
        });
    } finally { db.close(); }
});

test("{§matcher-dispatch} editing foo's referrer away drops it from &<foo after index maintenance", async () => {
    const { db, workspaceId, sessionId } = await seed();
    try {
        // b.ts no longer references foo — re-deriving its rows must remove the edge.
        await new Workspace().edit(editStmt(url("b.ts"), "export const x = 1;\n", fullReplace), makeSchemeCtx({ db, workspaceId, sessionId }));
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await find(db, workspaceId, sessionId, "&<foo");
        assert.equal(r.status, 204);
        assert.deepEqual([...new Set(resourcePaths(r))], []);
    } finally { db.close(); }
});

test("{§matcher-dispatch} persistent-index maintenance re-derives only on content change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await new Workspace().edit(editStmt(url("a.ts"), "export function foo() {}\n"), ctx);

        // Fresh counting wrapper — never mutate the shared DEFAULT_MIMETYPES (intg
        // runs concurrently). Counts only the symbols+references parse.
        let parses = 0;
        const counting = mimetypesFixture({
            process: (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                if (args[1]?.channels?.includes("symbols")) parses++;
                return DEFAULT_MIMETYPES.process(...args);
            },
        });
        const gctx = { ...ctx, mimetypes: counting };

        await SearchIndex.maintain(gctx);
        assert.equal(parses, 1, "first sight: content unseen → derive");
        await SearchIndex.maintain(gctx);
        assert.equal(parses, 1, "unchanged: deep_hash matches → skip the parse");

        await new Workspace().edit(editStmt(url("a.ts"), "export function bar() {}\n", fullReplace), ctx);
        await SearchIndex.maintain(gctx);
        assert.equal(parses, 2, "content changed → re-derive");
    } finally { db.close(); }
});
});

describe("json-response-presentation", () => {
test("{§http-json-presentation}: READ, FIND and COPY share formatted JSON coordinates", async (t) => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const ids = await seedEnvelope(db, `json-presentation-${crypto.randomUUID()}`, { producer: "client" });
    const schemes = new SchemeRegistry();
    schemes.register("https", new Http());
    const engine = new Engine({ db, schemes, mimetypes });
    const value = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, `value${i}`]));
    const source = JSON.stringify(value);
    const formatted = JSON.stringify(value, null, 2);
    const target = "https://93.184.216.34/data.json";
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => requestUrl(input).endsWith("/llms.txt")
        ? new Response(null, { status: 404 })
        : new Response(source, { headers: { "content-type": "application/json", "cache-control": "max-age=600" } }));
    let sequence = 0;
    const dispatch = async (dsl: string) => {
        const parsed = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) });
        const item = parsed.items.find((candidate) => candidate.kind === "statement");
        assert.equal(item?.kind, "statement", dsl);
        if (item?.kind !== "statement") throw new Error("operation did not parse");
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "client", statement: item.statement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence,
        });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    try {
        const whole = await dispatch(`\`\`\`\`READ (${target})\`\`\`\``);
        assert.equal(whole.status, 200);
        assert.equal(whole.content, formatted, "a markerless READ is the whole formatted document ({§packet})");
        const scoped = await dispatch(`\`\`\`\`READ (${target}) <20,22>\`\`\`\``);
        assert.equal(scoped.content, formatted.split("\n").slice(19, 22).join("\n"));
        const found = await dispatch(`\`\`\`\`FIND (${target}) /value19/\`\`\`\``);
        assert.equal(found.status, 200);
        const locations = JSON.parse(found.content);
        assert.ok(locations.length > 0);
        assert.match(locations[0].region, /^<21,/u);
        assert.equal((await dispatch(`\`\`\`\`COPY (${target}) <20,22> (workspace:///selection.json)\`\`\`\``)).status, 201);
        const copied = await dispatch("````READ (workspace:///selection.json) <1,-1>````");
        assert.equal(copied.content, scoped.content);
        assert.equal((await dispatch(`\`\`\`\`EDIT (workspace:///literal.json)
${source}
\`\`\`\``)).status, 201);
        assert.equal((await dispatch("````READ (workspace:///literal.json) <1,-1>````")).content, source, "literal JSON resource coordinates and bytes are untouched");
    } finally {
        await mimetypes.dispose();
        await db.close();
    }
});
});

describe("pattern-indexed-selection", () => {
const RESOLVERS = [
    "class RoutePattern(CheckURLMixin):",
    "    regex = LocaleRegexDescriptor('_route')",
    "def resolve(self, path):",
    "    return RoutePattern(path)",
].join("\n");

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `indexed-pattern-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = async (source: string) => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/resolvers.py", content: RESOLVERS, mimetype: "text/x-python" });
    return { dispatch, db };
};

// {§read} {§matcher-dispatch}
test("{§op-invariants} a graph READ selects definitions and references without becoming a FIND", async (t) => {
    const { dispatch } = await runtime(t);
    const definition = await dispatch("````READ (workspace:///resolvers.py) &RoutePattern````");
    assert.equal(definition.status, 200);
    assert.equal(definition.content, "class RoutePattern(CheckURLMixin):\n    regex = LocaleRegexDescriptor('_route')");
    assert.deepEqual(definition.lineOrdinals, [1, 2]);
    const reference = await dispatch("````READ (workspace:///resolvers.py) &<RoutePattern````");
    assert.equal(reference.status, 200);
    assert.equal(reference.content, "    return RoutePattern(path)");
    assert.deepEqual(reference.matches.map(({ region }: { region: unknown }) => region), [
        { startLine: 4, startColumn: 12, endLine: 4, endColumn: 24 },
    ]);
    const find = await dispatch("````FIND (workspace:///resolvers.py) &RoutePattern````");
    assert.equal(find.status, 200);
    assert.deepEqual(find.results.map(({ region }: { region: unknown }) => region), definition.matches.map(({ region }: { region: unknown }) => region));
});

// {§op-invariants}
test("{§read} a full-text KILL removes the highlighted source token rather than its containing line", async (t) => {
    const { dispatch, db } = await runtime(t);
    const result = await dispatch("````KILL (workspace:///resolvers.py) ~LocaleRegexDescriptor````");
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.matched, 1);
    const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/resolvers.py", name: "body" });
    assert.equal(body?.content, RESOLVERS.replace("LocaleRegexDescriptor", ""));
});
});
