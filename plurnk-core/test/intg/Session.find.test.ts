import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { type CatalogResource, type FindResult } from "../../src/schemes/_entry-find.ts";
import { type FindStatement, type MatcherBody, type UrlPath, type ParsedPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type RepresentationPreparationRequest, type SchemeCtx } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, seedEnvelope, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { type Db } from "../../src/core/Db.ts";
import { serverProposals } from "./_approval.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";


describe("Session.find", () => {
// Tests for FIND on entry-bearing schemes (SPEC {§find}).










const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, matcher: MatcherBody | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker: null, matcher, body: null,
     position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });
const resources = (result: FindResult): CatalogResource[] =>
    result.results.filter((item): item is CatalogResource => Array.isArray(item));
const paths = (result: FindResult): string[] => resources(result).map(([item]) => item.path);

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

const seedEntries = async (db: Db, workspaceId: number, sessionId: number, entries: Array<[string, string]>) => {
    const k = new Workspace();
    for (const [pathname, body] of entries) {
        await k.edit(editStmt(url(pathname), body), makeSchemeCtx({ db, workspaceId, sessionId }));
    }
};

test("{§find} Session.find returns the scheme's catalog groups (JSON), filtered to matches", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [
            ["a", "alpha"], ["b", "beta"], ["c", "gamma"],
        ]);
        const r = await new Workspace().find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        // FIND is the filtered catalog: one default-first channel array per resource.
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(paths(r), ["workspace:///a", "workspace:///b", "workspace:///c"]);
        const projected = JSON.parse(r.content!) as Array<Array<Record<string, unknown>>>;
        assert.equal(projected[0]?.[0]?.tokens, resources(r)[0]?.[0].weight);
        assert.equal(Object.hasOwn(projected[0]?.[0] ?? {}, "weight"), false, "only final model projection calls curation weight tokens");
        const renderedRows = r.content!.split("\n");
        assert.equal(renderedRows.length, r.results.length, "each FIND result ordinal owns one physical JSON line");
        assert.match(renderedRows[0], /^\[\[\{"path":"workspace:\/\/\/a"/);
        assert.match(renderedRows[1], /^\[\{"path":"workspace:\/\/\/b"/);
        assert.match(renderedRows[2], /^\[\{"path":"workspace:\/\/\/c".*\}\]\]$/);
        const [first] = resources(r);
        assert.ok(first !== undefined);
        assert.equal(first.length, 1, "a single-channel resource is a one-element group");
        assert.equal(first[0].path, "workspace:///a");
        assert.ok("mimetype" in first[0], "an entry group contains channels, not a scope summary");
        assert.equal(typeof first[0].mimetype, "string");
        assert.equal(first[0].lines, 1, "\"alpha\" is one line");
        assert.equal(typeof first[0].weight, "number");
        assert.deepEqual(Object.keys(first[0]).toSorted(), ["lines", "mimetype", "path", "weight"], "a catalog channel carries exactly its path, mimetype, lines and weight");
    } finally { db.close(); }
});

test("{§find} Session.find with scope prefix filters to that subtree", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [
            ["plan/step1", "x"], ["plan/step2", "y"], ["other/thing", "z"],
        ]);
        const r = await new Workspace().find(findStmt(url("plan/")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["workspace:///plan/step1", "workspace:///plan/step2"]);
    } finally { db.close(); }
});

test("{§find} a single-star path glob lists one level with actionable recursive folder summaries", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [
            [".env.defaults", "defaults"],
            [".github/workflows/ci.yml", "workflow"],
            ["README.md", "root"],
            ["src/.hidden.ts", "hidden child"],
            ["src/index.ts", "direct child"],
            ["src/lib/deep.ts", "nested child"],
            ["docs/guide.md", "guide"],
        ]);
        const session = new Workspace();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });

        const root = await session.find(findStmt(url("*")), ctx);
        assert.equal(root.status, 200);
        assert.deepEqual(paths(root), [
            "workspace:///.env.defaults",
            "workspace:///.github/**",
            "workspace:///docs/**",
            "workspace:///README.md",
            "workspace:///src/**",
        ]);
        const src = resources(root).find(([item]) => item.path === "workspace:///src/**");
        assert.ok(src !== undefined && "items" in src[0], "the directory is a one-element scope group, not a fake entry");
        assert.equal(src[0].items, 3, "the summary counts every descendant recursively, including dot entries");
        assert.ok(src[0].weight > 0, "the summary reports the recursive subtree's READ weight");
        assert.equal(root.matchingPathCount, 2, "folder summaries never become matching resource paths");

        const drilled = await session.find(findStmt(url("src/*")), ctx);
        assert.deepEqual(paths(drilled), [
            "workspace:///src/.hidden.ts",
            "workspace:///src/index.ts",
            "workspace:///src/lib/**",
        ]);

        const dotDrill = await session.find(findStmt(url(".github/**")), ctx);
        assert.deepEqual(paths(dotDrill), ["workspace:///.github/workflows/ci.yml"]);

        const recursive = await session.find(findStmt(url("**")), ctx);
        assert.deepEqual(paths(recursive), [
            "workspace:///.env.defaults",
            "workspace:///.github/workflows/ci.yml",
            "workspace:///README.md",
            "workspace:///docs/guide.md",
            "workspace:///src/.hidden.ts",
            "workspace:///src/index.ts",
            "workspace:///src/lib/deep.ts",
        ], "double-star remains the complete recursive entry listing, dot entries included and without summary noise");
    } finally { db.close(); }
});

test("{§find} path globs use shell segment semantics and support native brace patterns", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [
            ["root.ts", "root"],
            ["src/direct.ts", "direct"],
            ["src/nested/deep.ts", "deep"],
            ["src/nested/deep.go", "go"],
        ]);
        const session = new Workspace();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });

        const oneLevel = await session.find(findStmt(url("src/*.ts")), ctx);
        assert.deepEqual(paths(oneLevel), ["workspace:///src/direct.ts"], "`*` never crosses `/`");

        const question = await session.find(findStmt(url("src/nested/deep.?s")), ctx);
        assert.deepEqual(paths(question), ["workspace:///src/nested/deep.ts"], "`?` matches one non-separator character");

        const recursive = await session.find(findStmt(url("src/**/*.ts")), ctx);
        assert.deepEqual(paths(recursive), [
            "workspace:///src/direct.ts",
            "workspace:///src/nested/deep.ts",
        ], "`**` crosses directories");

        const braces = await session.find(findStmt(url("**/*.{go,ts}")), ctx);
        assert.deepEqual(paths(braces), [
            "workspace:///root.ts",
            "workspace:///src/direct.ts",
            "workspace:///src/nested/deep.go",
            "workspace:///src/nested/deep.ts",
        ], "shell brace patterns are resolved by the native path matcher, not SQLite GLOB");
    } finally { db.close(); }
});

test("{§find} Session.find with glob matcher filters by CONTENT", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // Pathnames are neutral (a/b/c); the matchable token lives in the content.
        await seedEntries(db, workspaceId, sessionId, [
            ["a", "france is the topic"], ["b", "france and germany"], ["c", "italy only"],
        ]);
        const r = await new Workspace().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["workspace:///a", "workspace:///b"]);
    } finally { db.close(); }
});

test("{§find} a broad content match emits one item per resource with location counts", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // Multi-line content: the match sits on line 3 of a, line 2 of b; c never matches.
        await seedEntries(db, workspaceId, sessionId, [
            ["a", "intro\nbody\nfrance is here\ntail"],
            ["b", "header\nfrance again\nmore"],
            ["c", "italy only\nspain too"],
        ]);
        const r = await new Workspace().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        const byPath = new Map(resources(r).map(([row]) => [row.path, row] as const));
        assert.equal(byPath.get("workspace:///a")?.matchLocationCount, 1);
        assert.equal(byPath.get("workspace:///b")?.matchLocationCount, 1);
        assert.equal(r.matchLocationCount, 2);
        assert.equal(byPath.has("workspace:///c"), false, "a miss excludes the entry entirely — no item");
    } finally { db.close(); }
});
test("{§find} Session.find with regex matcher filters by CONTENT", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "alpha"], ["b", "beta"], ["c", "aardvark"]]);
        const r = await new Workspace().find(findStmt(url(""), regex("^a")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["workspace:///a", "workspace:///c"]);
    } finally { db.close(); }
});

test("{§slicer-text-algebra} Session.find preserves an invalid matcher's parser cause and recovery facts", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a.json", "{\"answer\":42}"]]);
        const r = await new Workspace().find(
            findStmt(url(""), { dialect: "jsonpath", raw: "$.[" }),
            makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }),
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "jsonpath");
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§slicer-text-algebra}
        assert.equal(r.problem?.retryable, false);
        assert.equal(r.problem?.detail, "The jsonpath matcher expression is invalid.", "the parser's actual cause survives the FIND boundary");
    } finally {
        db.close();
    }
});

test("{§find} Session.find regex honors flags — case-insensitive (i) on content", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "Alpha"], ["b", "alpine"], ["c", "beta"]]);
        // `i` must match "Alpha" (capital A) against /^al/ — the flag crosses into
        // the matcher's content regex; without it, `^al` would skip "Alpha".
        const ci: MatcherBody = { dialect: "regex", raw: "/^al/i", pattern: "^al", flags: "i" };
        const r = await new Workspace().find(findStmt(url(""), ci), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["workspace:///a", "workspace:///b"]);
    } finally { db.close(); }
});

test("{§find} Session.find regex accepts `g` flag on content (no throw)", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "foo here"], ["b", "a foo"], ["c", "bar"]]);
        // `g` doesn't change hit/no-hit for entry selection; it must not throw.
        const g: MatcherBody = { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" };
        const r = await new Workspace().find(findStmt(url(""), g), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["workspace:///a", "workspace:///b"]);
    } finally { db.close(); }
});

test("{§find} Session.find regex `y` (sticky) anchors at content start", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "foobar"], ["b", "a foobar"]]);
        // sticky → match only at position 0 of the content, not anywhere.
        const y: MatcherBody = { dialect: "regex", raw: "/foo/y", pattern: "foo", flags: "y" };
        const r = await new Workspace().find(findStmt(url(""), y), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["workspace:///a"]);
    } finally { db.close(); }
});

test("{§find} Session.find xpath matcher with no structural match → 204", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // xpath runs over the markdown deepXml; `//x` matches no element →
        // no content hit → excluded.
        await seedEntries(db, workspaceId, sessionId, [["a", "plain text"]]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "xpath", raw: "//x" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 204);
        assert.deepEqual([...new Set(paths(r))], []);
    } finally { db.close(); }
});

test("{§find} Session.find with <L> paginates results", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
        const stmt: ReturnType<typeof findStmt> = { ...findStmt(url(""), null), lineMarker: { marks: [2, 3] } };
        const r = await new Workspace().find(stmt, makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["workspace:///b", "workspace:///c"]);
        const one = await new Workspace().find(
            { ...findStmt(url(""), null), lineMarker: { marks: [2] } },
            makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }),
        );
        assert.equal(one.results.length, 1);
        assert.doesNotMatch(one.content!, /\n/, "a single result remains one compact JSON line");
    } finally { db.close(); }
});

test("{§packet} Session.find without a scope returns its first page of resources, every resource when they fit; an explicit <1,-1> is the whole", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const entries = Array.from({ length: 20 }, (_, index): [string, string] => [
            `entry-${String(index + 1).padStart(2, "0")}`,
            `content ${index + 1}`,
        ]);
        await seedEntries(db, workspaceId, sessionId, entries);
        const session = new Workspace();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });
        const whole = await session.find(findStmt(url("")), ctx);
        assert.equal(whole.results.length, 20);
        assert.equal(whole.range?.total, 20);
        assert.deepEqual(whole.range?.requested, [1, PAGE]);
        assert.deepEqual(whole.range?.returned, [1, 20]);
        assert.equal(whole.itemsWeightTotal, whole.returnedItemsWeightTotal, "nothing is held back");

        const all = await session.find(
            { ...findStmt(url("")), lineMarker: { marks: [1, -1] } },
            ctx,
        );
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.itemsWeightTotal, all.returnedItemsWeightTotal);
    } finally { db.close(); }
});

test("{§find} Session.find with no matches returns an empty 204 result", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "x"]]);
        const r = await new Workspace().find(findStmt(url(""), glob("nope*")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
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

test("{§find} Session.find reports a matcher miss before applying result pagination", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["a", "alpha"], ["b", "beta"]]);
        const statement: FindStatement = {
            ...findStmt(url(""), glob("nope*")),
            lineMarker: { marks: [30, 100] },
        };
        const result = await new Workspace().find(
            statement,
            makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }),
        );
        assert.equal(result.status, 204);
        assert.deepEqual(result.results, []);
        assert.equal(result.matchingPathCount, 0);
        assert.deepEqual(result.range, {
            unit: "resource",
            total: 0,
            requested: [30, 100],
        });
    } finally { db.close(); }
});

test("{§find} Session.find is scoped to the workspace (doesn't leak across workspaces)", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // Seed in this workspace
        await seedEntries(db, workspaceId, sessionId, [["here", "x"]]);

        // Create another workspace and seed there
        const otherWorkspaceId = await insertWorkspace(db, "other-workspace");
        const otherSessionId = await insertSession(db, otherWorkspaceId);
        const k = new Workspace();
        await k.edit(editStmt(url("elsewhere"), "y"), makeSchemeCtx({ db, workspaceId: otherWorkspaceId, sessionId: otherSessionId }));

        const r = await k.find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["workspace:///here"], "only entries from this workspace");
    } finally { db.close(); }
});

test("{§find} commons FIND is scoped to the scheme (doesn't leak across schemes)", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedEntries(db, workspaceId, sessionId, [["here-commons", "x"]]);

        await seedEntryWithChannel(db, { workspaceId, scheme: "fixture", pathname: "/here-commons", content: "y" });

        const r = await new Workspace().find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["workspace:///here-commons"], "the commons FIND never leaks another scheme's entries");
    } finally { db.close(); }
});
});

describe("Engine.find-recursive-glob", () => {
// #449 — a body FIND over a large member tree survives a member whose content crashes
// a mimetype handler (an unbalanced HTML template partial that walks Readability into a null).











const execFileP = promisify(execFile);

test("{§find} a body FIND over ~2k members with a handler-crashing member answers truthfully, not 500", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-findglob-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "main.go"), "package main\n");
        await Promise.all(Array.from({ length: 40 }, async (_dirSlot, dir) => {
            await mkdir(join(root, "test", `pkg${dir}`), { recursive: true });
            await Promise.all(Array.from({ length: 48 }, (_fileSlot, file) =>
                writeFile(join(root, "test", `pkg${dir}`, `case${file}_test.go`), `package pkg${dir}\n// marker case\n`)));
        }));
        // The corpus poison: an unbalanced template partial that crashes Readability.
        await writeFile(
            join(root, "test", "pkg0", "header.html"),
            "<header><div class=\"cart\"></a>{{ render \"/partials/mini-cart.html\" }}</div></header>\n",
        );
        await execFileP("git", ["add", "-A"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const mock = new Mock({ contextWindow: 200_000, responses: [
            makeMockResponse("````FIND (test/**) marker case````\n\n````NOTE\nlooking\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "findglob", projectRoot: root });
                const outcome = await runLoopToTerminal(ws, 2, { prompt: "find" }, { timeoutMs: 50_000 });
                assert.equal(outcome.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ session_id: outcome.modelSessionId! });
                const find = rows.find(({ op }) => op === "FIND");
                assert.ok(find, "the FIND row exists");
                assert.notEqual(find.status_rx, 500, `FIND must not 500: ${JSON.parse(find.rx).problem?.detail ?? find.rx.slice(0, 200)}`);
                assert.ok([200, 204, 404].includes(find.status_rx), `truthful status; got ${find.status_rx}`);
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("catalog-summary", () => {
// engine_scheme_catalog_summary — per-scheme entry and shallow-map row tallies that source
// the turn-0 foist, so its optional range is valid for the projection it actually renders.









const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}:///${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

test("{§find} [catalog] engine_scheme_catalog_summary tallies distinct entries per scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `catalog-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await new Workspace().edit(editStmt(url("workspace", "a.md"), "alpha beta"), ctx);
        await new Workspace().edit(editStmt(url("workspace", "notes/b.md"), "gamma"), ctx);
        await new Workspace().edit(editStmt(url("workspace", "notes/deep/c.md"), "delta"), ctx);
        await seedEntryWithChannel(db, { workspaceId, scheme: "skill", authority: "recipe", pathname: "/SKILL.md", content: "a recipe" });
        await EntryCrud.writeEntry({ authority: "", pathname: "README.md" }, {
            channels: { body: { content: "root", mimetype: "text/markdown" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/a.ts" }, {
            channels: { body: { content: "a", mimetype: "text/typescript" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/deep/b.ts" }, {
            channels: { body: { content: "b", mimetype: "text/typescript" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "example.com:8443", pathname: "/x" }, {
            channels: { body: { content: "one", mimetype: "text/plain" } },
        }, ctx, "https");
        await EntryCrud.writeEntry({ authority: "example.com", pathname: "/8443:x" }, {
            channels: { body: { content: "two", mimetype: "text/plain" } },
        }, ctx, "https");

        const rows = await db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
        const byScheme = new Map(rows.map((r) => [r.scheme, r]));
        assert.equal(byScheme.get("workspace")?.entries, 3, "three commons entries tallied as distinct");
        assert.equal(byScheme.get("workspace")?.shallow_items, 2, "one root entry plus one notes/** scope form the shallow map");
        assert.equal(byScheme.get("skill")?.entries, 1, "one skill entry tallied");
        assert.equal(byScheme.get("file")?.entries, 3, "three project entries tallied as distinct");
        assert.equal(byScheme.get("file")?.shallow_items, 2, "one root file plus one src/** scope form the shallow map");
        assert.equal(byScheme.get("https")?.entries, 2, "resource authorities remain distinct");
        assert.equal(byScheme.get("https")?.shallow_items, 2, "authority and pathname boundaries cannot collide in the shallow tally");
    } finally { db.close(); }
});

// {§find} — prose clips at the bound; a fenced invocation-form summary (a tool
// family's menu) is shown whole, every tool named.
test("{§find} [catalog] a fenced invocation-form summary lists every tool while long prose still clips", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `catalog-aside-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const workspace = new Workspace();
        const targets = Array.from({ length: 30 }, (_, index) => `tool_number_${index + 1}_with_a_long_name`);
        const menu = `\`\`\`\`gitea (${targets.join("|")})\\n\`\`\`\``;
        await workspace.edit(editStmt(url("workspace", "menu.md"), `# gitea\n\n## Summary\n\n${menu}\n\n## Tools\n`), ctx);
        const prose = "word ".repeat(120).trim();
        await workspace.edit(editStmt(url("workspace", "prose.md"), `# prose\n\n## Summary\n\n${prose}\n`), ctx);
        await SearchIndex.maintain(ctx);
        const listing = await workspace.find({
            metadata: null, op: "FIND", aside: null, target: url("workspace", "*"),
            lineMarker: { marks: [1, -1] }, matcher: null, body: null, position: { line: 1, column: 1 },
        }, ctx);
        assert.equal(listing.status, 200, JSON.stringify(listing));
        const rows = (listing.results as Array<Array<{ path: string; aside?: string }>>).flat();
        const menuRow = rows.find(({ path }) => path === "workspace:///menu.md");
        assert.equal(menuRow?.aside, menu.replaceAll("\\n", "\n"), "the fenced witness is shown whole, every tool named, its newline restored");
        const proseRow = rows.find(({ path }) => path === "workspace:///prose.md");
        assert.ok(proseRow?.aside !== undefined && Array.from(proseRow.aside).length === 256 && proseRow.aside.endsWith("…"), `prose clips at the bound: ${proseRow?.aside?.length}`);
    } finally { await db.close(); }
});
});

describe("find-line-anchors", () => {
// The recorded shape (#853, orox): the module opens with a docstring, so a whole-text `^` never
// reached an import line and FIND answered 204 while the same READ selected them.
const RESOLVERS = [
    "\"\"\"",
    "This module converts requested URLs to callback view functions.",
    "\"\"\"",
    "import functools",
    "import inspect",
    "from importlib import import_module",
    "",
    "from django.conf import settings",
    "def get_resolver(urlconf=None):",
    "    return urlconf",
].join("\n");

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `find-line-anchors-${crypto.randomUUID()}`);
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
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/resolvers.py", content: RESOLVERS, mimetype: "text/plain" });
    return { dispatch };
};

const startLines = (found: { content: string }): number[] =>
    (JSON.parse(found.content) as Array<{ region: string }>).map(({ region }) => Number(region.slice(1).split(",")[0]));

test("{§find}: the recorded `FIND (x.py) /^from|^import/` locates the lines READ selects", async (t) => {
    const { dispatch } = await runtime(t);
    const found = await dispatch("````FIND (workspace:///resolvers.py) /^from|^import/ <!-- current imports -->````");
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(startLines(found), [4, 5, 6, 8]);
    const read = await dispatch("````READ (workspace:///resolvers.py) /^from|^import/````");
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "import functools\nimport inspect\nfrom importlib import import_module\nfrom django.conf import settings");
    const tail = await dispatch("````FIND (workspace:///resolvers.py) /urlconf$/````");
    assert.equal(tail.status, 200, JSON.stringify(tail));
    assert.deepEqual(startLines(tail), [10], "`$` is a line's end as well");
});

test("{§find}: a log FIND anchors each line of the row it searches", async (t) => {
    const { dispatch } = await runtime(t);
    assert.equal((await dispatch("````READ (workspace:///resolvers.py) <1,-1>````")).status, 200);
    const found = await dispatch("````FIND (log:///1/1/1/READ) /^from|^import/````");
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(startLines(found), [4, 5, 6, 8]);
});
});

describe("find-read-orthogonal", () => {
// {§op-shapes} and {§find-result-projection}: broad FIND locates
// resources; READ retrieves one exact target.












const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null, target,
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, matcher: MatcherBody | null = null, lineMarker: FindStatement["lineMarker"] = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target,
    lineMarker, matcher, body: null,  position: { line: 1, column: 1 },
});

const seed = async (db: Db, workspaceId: number, sessionId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Workspace().edit(
        { metadata: null, op: "EDIT", aside: null, target: urlPath("workspace", path), lineMarker: null, matcher: null, body: content, position: { line: 1, column: 1 } },
        makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
    );
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `fanout-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "fanout");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes });
    return { db, workspaceId, sessionId, loopId, turnId, mimetypes, schemes, engine };
};

test("{§op-shapes} FIND locates resources by glob matcher", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "intro\nfrance alpha\ntail");
        await seed(db, workspaceId, sessionId, mimetypes, "/b", "france beta\nmore");
        await seed(db, workspaceId, sessionId, mimetypes, "/c", "italy\nspain");

        const r = await engine.dispatch({
            statement: findStmt(urlPath("workspace", "/**"), { dialect: "glob", raw: "france*" }),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });

        assert.equal(r.status, 200);
        assert.equal((r as { matchingPathCount?: number }).matchingPathCount, 2);
        assert.equal((r as { matchLocationCount?: number }).matchLocationCount, 2);
    } finally { await db.close(); }
});

test("{§op-shapes} FIND with zero matches returns 204", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "italy");
        await seed(db, workspaceId, sessionId, mimetypes, "/b", "spain");
        const r = await engine.dispatch({
            statement: findStmt(urlPath("workspace", "/**"), { dialect: "glob", raw: "france*" }),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 204);
    } finally { await db.close(); }
});

test("{§op-shapes} exact READ returns target content", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "france one");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("workspace", "/a")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200);
        assert.match((typeof r.content === "string" ? r.content : ""), /france one/);
    } finally { await db.close(); }
});

test("{§op-shapes} trailing slash is ordinary resource syntax unless the scheme declares folder scopes", async () => {
    class OpaqueResource {
        static manifest = {
            name: "opaque", channels: { body: "text/markdown" }, defaultChannel: "body",
            category: "data" as const, writableBy: [] as const,
            volatile: false, modelVisible: true,
        };
        async prepareRepresentation(
            request: RepresentationPreparationRequest,
            ctx: SchemeCtx,
        ) {
            await ctx.entries.write(request.pathname, {
                channels: {
                    body: { content: "opaque root resource", mimetype: "text/markdown" },
                },
            });
            return { status: 200 };
        }
        async find(): Promise<never> { throw new Error("undeclared folder scope must never invoke FIND"); }
    }
    const { db, workspaceId, sessionId, loopId, turnId, schemes, engine } = await setup();
    try {
        schemes.register("opaque", new OpaqueResource());
        const result = await engine.dispatch({
            statement: readStmt(urlPath("opaque", "/")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
        assert.match(row?.rx ?? "", /opaque root resource/);
    } finally { await db.close(); }
});
});

