import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntryFind, { type CatalogResource, type FindResult } from "../../src/schemes/_entry-find.ts";
import Session from "../../src/schemes/Session.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { type FindStatement, type MatcherBody, type UrlPath, type ParsedPath, type ReadStatement, type PlurnkStatement, type LineMarker } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type RepresentationPreparationRequest, type SchemeCtx } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, seedEnvelope, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readThroughScheme } from "./_scheme.ts";
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
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { matchLocations, resourceGroups, resourcePaths } from "./_find.ts";
import { setTimeout as sleep } from "node:timers/promises";

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

test("{§problems-schemes} Session.find preserves an invalid matcher's parser cause and recovery facts", async () => {
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
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§problems-schemes}
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
// {§read-exact-target} and {§find-result-projection}: broad FIND locates
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

test("{§read-exact-target} FIND locates resources by glob matcher", async () => {
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

test("{§read-exact-target} FIND with zero matches returns 204", async () => {
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

test("{§read-exact-target} exact READ returns target content", async () => {
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

test("{§read-exact-target} trailing slash is ordinary resource syntax unless the scheme declares folder scopes", async () => {
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

describe("find-read-uniform", () => {
// {§find-result-projection}, {§read-exact-target}. Broad FIND selects resources;
// exact-target matcher FIND reports flat match locations. Exact READ projects
// text from one selected resource. These exercise the real dispatch path, not scheme methods
// in isolation. Real Mimetypes so
// JSONPath/XPath resolve; SearchIndex.maintain makes graph and FTS queries ready.
















const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find((i) => i.kind === "statement" && i.statement.op === op);
    if (found === undefined) throw new Error(`no ${op} parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: T }).statement;
};

const setup = async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `uniform-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "uniform");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, mimetypes });
    return { db, engine, mimetypes, workspaceId, sessionId, loopId, turnId, ctx };
};

// Seed arbitrary literal content without making the fixture itself responsible for
// delimiter collisions: parse a minimal statement, then replace its typed AST body.
const seedRaw = async (ctx: ReturnType<typeof makeSchemeCtx>, name: string, content: string): Promise<void> => {
    const k = new Workspace();
    const stmt = parseOp<ResolvedEditStatement>(`\`\`\`\`EDIT (workspace:///${name})
x
\`\`\`\``, "EDIT");
    await k.edit({ ...stmt, body: content }, ctx);
};

type StoredRead = {
    content?: string;
    startLine?: number | null;
    status?: number;
    matches?: Array<{
        region?: {
            startLine: number;
            startColumn: number;
            endLine: number;
            endColumn: number;
        };
        locator?: string;
    }>;
};

// Dispatch an op and collect every resource delivery's stored result.
const dispatchRows = async (
    db: Db, engine: Engine, ids: { workspaceId: number; sessionId: number; loopId: number; turnId: number },
    statement: PlurnkStatement,
): Promise<{ result: { status: number; rowsWritten?: number }; rows: StoredRead[] }> => {
    const result = await engine.dispatch({ statement, ...ids, sequence: 1, origin: "model" }) as { status: number; rowsWritten?: number };
    const rows: StoredRead[] = [];
    for (let s = 1; s <= (result.rowsWritten ?? 1); s++) {
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence: s });
        if (row !== undefined) rows.push(JSON.parse(row.rx) as StoredRead);
    }
    return { result, rows };
};

// --- FIND projects resources or locations from the authored target shape -----

test("{§find-result-projection} FIND recognizes shell character-class paths as globs", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a1.md", "one");
        await seedRaw(ctx, "a2.md", "two");
        await seedRaw(ctx, "nested/a3.md", "three");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///a[12].md)````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} exact glob-pattern FIND returns flat matched-line locations", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target\ndelta target");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///log.md) *target*````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} regex FIND returns matched resources", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "intro\nerror: one\ntail");
        await seedRaw(ctx, "b.md", "error: two\nmore");
        await seedRaw(ctx, "c.md", "clean");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///**) /error: \\w+/````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} exact jsonpath FIND returns flat locators with exact regions", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "team.json", '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///team.json) $.users[*].name````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} two structural matches on one source line remain distinguishable by locator", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "one.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///one.json) $.users[*].name````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} a matcher FIND with zero matches returns 204", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "nothing here");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///**) *absent*````", "FIND"));
        assert.equal(result.status, 204);
    } finally { await db.close(); }
});

test("{§find-result-projection} full-text FIND uses ranking to select resources", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "db.md", "the database connection failed with a timeout error");
        await seedRaw(ctx, "cake.md", "preheat the oven and frost the birthday cake");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///**) ~database connection error````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} exact xpath FIND returns flat locator evidence", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "page.html", "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///page.html) //li````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} broad &graph FIND returns selected resource channel groups", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///**) &<foo````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("{§find-result-projection} broad &graph FIND reports each resource's location count without nesting coordinates on multi-match rows", async () => {
    const { db, workspaceId, sessionId, mimetypes, ctx, loopId, turnId } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        // This low-level query owns explicit indexing, so prepare the catalog
        // (including accepted message sources) before settling its index.
        const catalog = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///**)````", "FIND"), ctx);
        assert.equal(catalog.status, 200);
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, mimetypes }));
        const r = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///**) &<foo````", "FIND"), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.ok(r.results.length >= 1);
        const rows = resourceGroups(r).map(([item]) => item);
        assert.ok(rows.every((item) => item.matchLocationCount !== undefined && item.matchLocationCount >= 1));
        assert.ok(rows.every((item) => (item.matchLocationCount ?? 0) <= 1 || item.region === undefined), "a multi-match resource keeps only its count, never nesting regions");
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

// --- The target contract: bare = exact, folder/glob = scope ------

test("{§find-result-projection} FIND(bare entry) is the one entry, never a prefix that pulls siblings", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "config.md", "the config");
        await seedRaw(ctx, "config.md.bak", "the backup");
        const r = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///config.md)````", "FIND"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.deepEqual(resourcePaths(r), ["workspace:///config.md"], "bare = exact: config.md.bak is NOT pulled in");
    } finally { await db.close(); }
});

test("{§find-result-projection} FIND(folder/) returns the folder's contents; a glob is a scope", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha");
        await seedRaw(ctx, "docs/b.md", "beta");
        await seedRaw(ctx, "top.md", "top");
        const r = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///docs/)````", "FIND"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.deepEqual(resourcePaths(r).toSorted(), ["workspace:///docs/a.md", "workspace:///docs/b.md"], "folder/ = its contents, not top.md");
    } finally { await db.close(); }
});

test("{§find-result-projection} FIND(folder/) locates the folder's contents", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha body");
        await seedRaw(ctx, "docs/b.md", "beta body");
        await seedRaw(ctx, "top.md", "top body");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("````FIND (workspace:///docs/)````", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// --- FIND projects resources or locations according to target shape ----------

test("{§find-result-projection} broad matcher FIND emits one item per resource with a complete location count", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target");
        const r = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///**) *target*````", "FIND"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 1);
        assert.equal(resourceGroups(r)[0]?.[0].path, "workspace:///log.md");
        assert.equal(resourceGroups(r)[0]?.[0].matchLocationCount, 2);
        assert.equal("region" in (resourceGroups(r)[0]?.[0] ?? {}), false, "a multi-match resource never nests its regions");
        assert.equal("locator" in (resourceGroups(r)[0]?.[0] ?? {}), false, "a multi-match resource never nests its locator");
        assert.equal(r.matchingPathCount, 1);
        assert.equal(r.matchLocationCount, 2);
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

test("{§find-result-projection} broad matcher FIND promotes a resource's locator/region when it matches exactly once", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "one.md", "alpha\ntarget\nbeta");
        await seedRaw(ctx, "two.md", "target\nand target again\n");
        const r = await new Workspace().find(
            parseOp<FindStatement>("````FIND (workspace:///**) *target*````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(r.status, 200);
        const byPath = new Map(resourceGroups(r).map(([item]) => [item.path, item]));
        const one = byPath.get("workspace:///one.md");
        const two = byPath.get("workspace:///two.md");
        assert.equal(one?.matchLocationCount, 1);
        assert.ok(one?.region !== undefined, "exactly one match → the region is promoted to the resource row");
        assert.equal(two?.matchLocationCount, 2);
        assert.equal(two?.region, undefined, "two matches → count only, no region");
    } finally { await db.close(); }
});

test("{§find-result-unit} a glob remains resource mode when it resolves to one matching path", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "only.md", "first target\nsecond target");
        await seedRaw(ctx, "other.txt", "target");
        const r = await new Workspace().find(
            parseOp<FindStatement>("````FIND (workspace:///*.md) *target*````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(resourceGroups(r).map(([{ path, matchLocationCount }]) => ({ path, matchLocationCount })), [{
            path: "workspace:///only.md",
            matchLocationCount: 2,
        }]);
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

test("{§packet} a markerless exact matcher FIND returns its first page of locations, every location when they fit; <1,-1> is the whole", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "many.md", Array.from({ length: 20 }, (_, i) => `target ${i + 1}`).join("\n"));
        const session = new Workspace();
        const first = await session.find(
            parseOp<FindStatement>("````FIND (workspace:///many.md) *target*````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(first.results.length, 20);
        assert.equal(first.matchingPathCount, 1);
        assert.equal(first.matchLocationCount, 20);
        assert.equal(first.range?.unit, "matchLocation");
        assert.equal(first.range?.total, 20);
        assert.deepEqual(first.range?.requested, [1, PAGE]);
        assert.deepEqual(first.range?.returned, [1, 20]);

        const all = await session.find(
            parseOp<FindStatement>("````FIND (workspace:///many.md) <1,-1> *target*````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
    } finally { await db.close(); }
});

test("{§find-result-projection} FIND on an exact target with a result-position scope", async () => {
    // ### FIND_ (workspace:///doc.md) <1> — the scope selects the first result of
    // an exact-target listing; a single-target FIND returns that target.
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "doc.md", "hello world hello again");
        const result = await new Workspace().find(
            parseOp<FindStatement>("````FIND (workspace:///doc.md) <1>````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(result.results.length, 1);
        assert.equal(resourceGroups(result)[0]?.[0].path, "workspace:///doc.md");
    } finally { await db.close(); }
});

test("{§find-result-unit} FIND on an exact target with a content matcher pages flat match locations", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "doc.md", "hello world hello again");
        const result = await new Workspace().find(
            parseOp<FindStatement>("````FIND (workspace:///doc.md) <1> /hello/````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(result.results.length, 1);
        assert.deepEqual(matchLocations(result)[0]?.region, {
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 6,
        });
        assert.equal("path" in (result.results[0] ?? {}), false);
        assert.equal(result.matchingPathCount, 1);
        assert.equal(result.matchLocationCount, 2);
        assert.equal(result.range?.unit, "matchLocation");
        assert.deepEqual(result.range?.returned, [1, 1]);
    } finally { await db.close(); }
});

test("{§read-find-normalization}: a glob survey is an authored FIND; a pattern on an exact READ stays a READ", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "target one\ntarget two");
        await seedRaw(ctx, "b.md", "other");
        const session = new Workspace();

        const globRead = parseOp<FindStatement>("````FIND (workspace:///*.md) <2>````", "FIND");
        const resourcePage = await session.find(
            globRead,
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(resourcePage.range?.unit, "resource");
        assert.deepEqual(resourcePaths(resourcePage), ["workspace:///b.md"]);

        // {§read} — an exact target with a pattern stays a READ: the pattern selects the
        // lines to show, it does not turn the operation into a search.
        const patternRead = parseOp<ReadStatement>("````READ (workspace:///a.md) <2> /target/````", "READ");
        assert.equal(patternRead.op, "READ");
        assert.equal(patternRead.matcher?.dialect, "regex");
        assert.deepEqual(patternRead.lineMarker, { marks: [2] });
    } finally { await db.close(); }
});

test("{§find-result-projection} broad FIND pagination counts selected resources, not match locations", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "target one\ntarget two\ntarget three");
        await seedRaw(ctx, "b.md", "target four");
        const result = await new Workspace().find(
            parseOp<FindStatement>("````FIND (workspace:///**) <2> *target*````", "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(resourcePaths(result), ["workspace:///b.md"]);
        assert.equal(resourceGroups(result)[0]?.[0].matchLocationCount, 1);
        assert.equal(result.matchingPathCount, 2);
        assert.equal(result.matchLocationCount, 4);
        assert.equal(result.range?.unit, "resource");
    } finally { await db.close(); }
});

test("{§find-result-projection} FIND coordinates compose into scoped READ for structured JSON", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "users.json", [
            "[",
            "  {",
            '    "name": "Alice",',
            '    "role": "admin"',
            "  },",
            "  {",
            '    "name": "Bob",',
            '    "role": "user"',
            "  }",
            "]",
        ].join("\n"));
        const session = new Workspace();
        const found = await session.find(
            parseOp<FindStatement>('````FIND (workspace:///users.json) $[?(@.role=="admin")]````', "FIND"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(found.results, [{
            channel: "body",
            locator: "$[0]",
            region: { startLine: 2, startColumn: 3, endLine: 5, endColumn: 4 },
        }]);
        const span = matchLocations(found)[0];
        assert.ok(span?.region);
        const read = await readThroughScheme("workspace", null,
            {
                ...parseOp<ReadStatement>("````READ (workspace:///users.json) <1,1,1,1>````", "READ"),
                lineMarker: {
                    marks: [
                        span.region.startLine,
                        span.region.startColumn,
                        span.region.endLine,
                        span.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(read.status, 200);
        assert.deepEqual(JSON.parse(read.content ?? ""), { name: "Alice", role: "admin" });
    } finally { await db.close(); }
});

test("{§find-result-projection} body-less FIND is the catalog without match metadata", async () => {
    const { db, workspaceId, sessionId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "alpha");
        await seedRaw(ctx, "b.md", "beta");
        const r = await new Workspace().find(parseOp<FindStatement>("````FIND (workspace:///**)````", "FIND"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.results.length, 2, "two entries → two catalog channel groups");
        assert.ok(resourceGroups(r).every(([item]) => !("matches" in item)));
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});
});

describe("find-result-projection", () => {
// {§find-result-projection}: FIND bounds materialization through its ordinary
// result pagination, with one compact extent over the selected result unit.








const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const findAll = (marks: [number, ...number[]] | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: { kind: "url", raw: "workspace:///**", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/**", query: null, fragment: null },
    lineMarker: marks === null ? null : { marks }, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§question-tool} shallow FIND folder summaries include only admitted candidates", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-visibility-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        for (const pathname of ["/visible/note.md", "/hidden/secret.md"]) {
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname, channel: "body", content: "content", mimetype: "text/markdown" });
        }
        const result = await EntryFind.findWorkspaceEntries(
            { ...findAll([1, -1]), target: parsePath("workspace:///*") },
            makeSchemeCtx({ db, workspaceId, sessionId }),
            Workspace.manifest,
            { visible: (pathname) => pathname.startsWith("/visible/") },
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.results.flatMap((item) => Array.isArray(item) ? item.map(({ path }) => path) : []), ["workspace:///visible/**"]);
        assert.equal(result.range?.total, 1);
        assert.doesNotMatch(result.content!, /hidden/);
    } finally { await db.close(); }
});

test("{§find-result-projection} {§packet}: a markerless FIND returns its first page of resources with complete counts", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-page-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        for (let i = 0; i < 20; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: `/e${i.toString().padStart(2, "0")}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const r = await EntryFind.findWorkspaceEntries(findAll(), ctx, Workspace.manifest, {  });
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 20);
        assert.equal(r.matchingPathCount, 20);
        assert.equal(r.matchLocationCount, 0);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(r.range, {
            unit: "resource",
            total: 20,
            requested: [1, PAGE],
            returned: [1, 20],
        });
    } finally {
        await db.close();
    }
});

test("{§find-result-projection}: explicit later and all-results pages use the same resource unit", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-explicit-page-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        for (let i = 0; i < 20; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: `/e${i.toString().padStart(2, "0")}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const continued = await EntryFind.findWorkspaceEntries(findAll([17, -1]), ctx, Workspace.manifest, {  });
        assert.equal(continued.results.length, 4);
        assert.equal(continued.range?.unit, "resource");
        assert.equal(continued.matchingPathCount, 20);

        const all = await EntryFind.findWorkspaceEntries(findAll([1, -1]), ctx, Workspace.manifest, {  });
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.matchingPathCount, 20);
    } finally {
        await db.close();
    }
});

test("{§find-result-projection} {§range-extent}: a FIND range of three or four positions is refused, naming them as written and no extent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-arity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "one\ntwo\n", mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        for (const marks of [[2, 1, 4], [1620, 1, 1660, 1]] as Array<[number, ...number[]]>) {
            const refused = await EntryFind.findWorkspaceEntries(findAll(marks), ctx, Workspace.manifest, {});
            assert.equal(refused.status, 416, JSON.stringify(marks));
            assert.deepEqual(refused.problem?.requestedPositions, marks);
            assert.equal(Object.hasOwn(refused, "range"), false, "the receipt carries no extent");
            assert.equal(refused.problem?.range, undefined);
        }
    } finally { await db.close(); }
});
});

describe("fulltext", () => {
// {§find-result-projection} {§persistent-search-index} {§find-result-projection}










const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const edit = (pathname: string, body: string, lineMarker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null, op: "EDIT", aside: null, target: url(pathname), lineMarker, body,
    matcher: null, position: { line: 1, column: 1 },
});
const find = (pathname: string, query: string, marks: LineMarker["marks"] = [1, -1]): FindStatement => ({
    metadata: null, op: "FIND", aside: null, target: url(pathname),
    lineMarker: { marks }, matcher: { dialect: "fts", raw: `~${query}` }, body: null,
    position: { line: 1, column: 1 },
});

test("{§find-result-projection} native FTS5 expressions select visible resources and integer result pages", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        for (const [path, body] of [
            ["a.txt", "connection reset retry"],
            ["b.txt", "connection refused retrying"],
            ["c.txt", "the birthday cake"],
        ]) assert.equal((await session.edit(edit(path, body), ctx)).status, 201);
        await SearchIndex.maintain(ctx);
        for (const [query, paths] of [
            ['"connection reset"', ["a.txt"]],
            ["connection NOT reset", ["b.txt"]],
            ["reset OR cake", ["a.txt", "c.txt"]],
            ["connection AND retry*", ["a.txt", "b.txt"]],
            ["NEAR(connection reset, 2)", ["a.txt"]],
        ] as const) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 200, query);
            assert.deepEqual(resourcePaths(result).toSorted(), paths.map((path) => `workspace:///${path}`), query);
        }
        const complete = await session.find(find("*", "connection"), ctx);
        const page = await session.find(find("*", "connection", [2]), ctx);
        assert.deepEqual(resourcePaths(page), resourcePaths(complete).slice(1, 2));
        assert.equal((await session.find(find("a.txt", "cake"), ctx)).status, 204);

        const otherWorkspace = await insertWorkspace(db, `fts-other-${crypto.randomUUID()}`);
        const otherSession = await insertSession(db, otherWorkspace);
        const other = makeSchemeCtx({ db, workspaceId: otherWorkspace, sessionId: otherSession });
        await session.edit(edit("private.txt", "connection reset retry"), other);
        await SearchIndex.maintain(other);
        assert.deepEqual(resourcePaths(await session.find(find("*", '"connection reset"'), ctx)), ["workspace:///a.txt"]);
        assert.deepEqual(
            await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }),
            [],
            "source processing and FTS5 queries create no inference calls",
        );
    } finally { await db.close(); }
});

test("{§find-result-projection} FTS5 locations preserve Unicode columns, line endings and multi-line phrases", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-coordinates-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("text.txt", "😀 café\r\nconnection\nreset\r\n\u001f[ retry \u001f]"), ctx);
        await SearchIndex.maintain(ctx);
        const accented = await session.find(find("text.txt", "cafe"), ctx);
        assert.equal(accented.status, 200);
        assert.deepEqual(matchLocations(accented).map(({ matched, region }) => ({ matched, region })), [
            { matched: "café", region: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 7 } },
        ]);
        const phrase = await session.find(find("text.txt", '"connection reset"'), ctx);
        assert.equal(phrase.status, 200);
        assert.deepEqual(matchLocations(phrase).map(({ matched, region }) => ({ matched, region })), [
            { matched: "connection\nreset", region: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 6 } },
        ]);
        const collision = await session.find(find("text.txt", "retry"), ctx);
        assert.equal(collision.status, 200);
        assert.deepEqual(matchLocations(collision).map(({ matched }) => matched), ["retry"]);
    } finally { await db.close(); }
});

test("{§find-result-projection} FTS5 reindexing replaces old terms, uses complete bodies and preserves stable ties", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-freshness-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("b.txt", "same search terms"), ctx);
        await session.edit(edit("a.txt", "same search terms"), ctx);
        await session.edit(edit("deep.txt", "filler\n".repeat(2000) + "lateuniqueword"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "same"), ctx)), ["workspace:///a.txt", "workspace:///b.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "lateuniqueword"), ctx)), ["workspace:///deep.txt"]);
        await session.edit(edit("a.txt", "replacement", { marks: [1, -1] }), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "same"), ctx)), ["workspace:///b.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "replacement"), ctx)), ["workspace:///a.txt"]);
    } finally { await db.close(); }
});

test("{§find-result-projection} malformed native FTS5 queries return their parser diagnostic without guessing intent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-invalid-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("text.txt", "example"), ctx);
        await SearchIndex.maintain(ctx);
        for (const [query, diagnostic] of [
            ['"unterminated', "unterminated string"],
            ["missing:word", "no such column: missing"],
            ["AND", 'fts5: syntax error near "AND"'],
            ["NEAR(example, xx)", 'expected integer, got "xx"'],
        ]) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 400, query);
            assert.equal(result.problem?.diagnostic, diagnostic);
            assert.equal(result.problem?.dialect, "fts");
            assert.deepEqual(result.results, []);
        }
    } finally { await db.close(); }
});

// The recorded shape (#853): `FIND (doc/**) ~inherited-members` leaked "no such column: members".
test("{§find-result-projection}: a word with inner punctuation searches its tokens as a phrase", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-phrase-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        for (const [path, body] of [
            ["autodoc.rst", "The :inherited-members: option documents inherited members."],
            ["other.rst", "members inherited from a base, in the other order"],
            ["cpp.rst", "Parsers for c++ and x.y paths under a/b."],
        ]) assert.equal((await session.edit(edit(path, body), ctx)).status, 201);
        await SearchIndex.maintain(ctx);
        for (const [query, paths] of [
            ["inherited-members", ["autodoc.rst"]],
            ["inherited-members AND option", ["autodoc.rst"]],
            ["c++", ["cpp.rst"]],
            ["x.y OR a/b", ["cpp.rst"]],
            ["^parsers-for*", ["cpp.rst"]],
        ] as const) {
            const result = await session.find(find("*", query), ctx);
            assert.equal(result.status, 200, `${query}: ${JSON.stringify(result.problem)}`);
            assert.deepEqual(resourcePaths(result).toSorted(), paths.map((path) => `workspace:///${path}`), query);
        }
        const excluded = await session.find(find("*", "inherited -members"), ctx);
        assert.equal(excluded.status, 400, "a leading `-` stays FTS5's column exclusion");
        assert.equal(excluded.problem?.recovery, "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them."); // {§diagnostic-observation}
    } finally { await db.close(); }
});

test("{§find-result-projection} FTS5 uses native BM25 relevance before the identity tie-breaker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-rank-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        await session.edit(edit("a.txt", "needle " + "irrelevant ".repeat(100)), ctx);
        await session.edit(edit("z.txt", "needle needle"), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(resourcePaths(await session.find(find("*", "needle"), ctx)), ["workspace:///z.txt", "workspace:///a.txt"]);
        assert.deepEqual(resourcePaths(await session.find(find("*", "needle", [1]), ctx)), ["workspace:///z.txt"]);
    } finally { await db.close(); }
});

test("{§find-result-projection} FTS5 respects literal namespaces and removes deleted targets from every observer's results", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "first");
        const siblingId = await insertSession(db, workspaceId, null, "second");
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const sibling = makeSchemeCtx({ db, workspaceId, sessionId: siblingId });
        const workspace = new Workspace();
        const session = new Session();
        const owned = { ...url("note.txt"), scheme: "session", raw: "session://first/note.txt", hostname: "first" };
        const second = { ...url("note.txt"), scheme: "session", raw: "session://second/note.txt", hostname: "second" };
        await workspace.edit(edit("note.txt", "commonsneedle"), ctx);
        await session.edit({ ...edit("note.txt", "firstneedle"), target: owned }, ctx);
        await session.edit({ ...edit("note.txt", "secondneedle"), target: second }, sibling);
        await SearchIndex.maintain(ctx);
        const query = "commonsneedle OR firstneedle OR secondneedle";
        assert.deepEqual(resourcePaths(await workspace.find(find("*", query), ctx)), ["workspace:///note.txt"]);
        const ownFind = { ...find("*", query), target: { ...url("*"), scheme: "session", raw: "session://first/*", hostname: "first" } };
        assert.deepEqual(resourcePaths(await session.find(ownFind, ctx)), ["session://first/note.txt"]);
        assert.deepEqual(resourcePaths(await session.find(ownFind, sibling)), ["session://first/note.txt"]);
        assert.equal((await session.find({ ...ownFind, matcher: { dialect: "fts", raw: "~secondneedle" } }, ctx)).status, 204);
        assert.equal((await session.killEntry({
            ...find("note.txt", query), op: "KILL", target: owned, matcher: null, body: null, lineMarker: null,
        }, ctx)).status, 200);
        await SearchIndex.maintain(ctx);
        assert.equal((await session.find(ownFind, ctx)).status, 204);
        assert.equal((await session.find(ownFind, sibling)).status, 204);
        assert.deepEqual(resourcePaths(await session.find({ ...ownFind, target: { ...ownFind.target, hostname: "second", raw: "session://second/*" } }, ctx)), ["session://second/note.txt"], "the independent namespace is preserved");
        assert.deepEqual(resourcePaths(await workspace.find(find("*", query), ctx)), ["workspace:///note.txt"], "the commons remain independent");
    } finally { await db.close(); }
});
});

describe("manifest-order", () => {
// User Note 5 — the catalog is ordered by mtime (entries.updated_at), oldest-modified
// first / newest last, so the prompt-cache prefix (dormant entries) stays stable across
// turns and churn clusters at the tail. A re-edited entry moves to the tail while the rest
// hold their positions. catalogRowsFor renders engine_list_workspace_entries' order verbatim.










const url = (p: string): UrlPath => ({ kind: "url", raw: `workspace:///${p}`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, query: null, fragment: null });
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({ metadata: null, op: "EDIT", aside: null, target, lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 } });

test("{§find-result-projection} catalog is mtime-ordered — a re-edited entry sorts to the tail, the rest hold their prefix", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mtime-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const k = new Workspace();
        // Distinct sub-second mtimes via short spacing; a re-edit of `a` makes it newest.
        await k.edit(editStmt(url("a.md"), "alpha"), ctx); await sleep(10);
        await k.edit(editStmt(url("b.md"), "bravo"), ctx); await sleep(10);
        await k.edit(editStmt(url("c.md"), "charlie"), ctx); await sleep(10);
        await k.edit(editStmt(url("a.md"), "alpha-2", fullReplace), ctx); // re-edit a — now most-recently-modified

        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const sessionEntries = catalog.map(([channel]) => channel.path).filter((p) => p.startsWith("workspace:///"));
        assert.deepEqual(sessionEntries, ["workspace:///b.md", "workspace:///c.md", "workspace:///a.md"],
            "b, c, then the re-edited a at the tail — oldest-modified first");
    } finally { await db.close(); }
});
});

describe("matcher-content-conformance", () => {
// Composed coverage for {§find},
// {§find}, and {§find-result-projection}. Fixtures put matching
// text in either the pathname or content, never both, so querying the wrong
// surface cannot pass accidentally.












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

const findStmt = (target: UrlPath, matcher: MatcherBody | null, lineMarker: LineMarker | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker, matcher, body: null,
     position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (pattern: string, flags = ""): MatcherBody =>
    ({ dialect: "regex", raw: flags ? `/${pattern}/${flags}` : `/${pattern}/`, pattern, flags });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

const seed = async (
    db: Db,
    workspaceId: number,
    sessionId: number,
    entries: Array<[string, string]>,
) => {
    const k = new Workspace();
    for (const [pathname, content] of entries) {
        await k.edit(editStmt(url(pathname), content), makeSchemeCtx({ db, workspaceId, sessionId }));
    }
};

// --- READ: exact-target text projection ----------------------------------
// Anchors "correct." The matched token appears ONLY in the content; the
// pathname shares no character with it, so a pathname-matcher returns nothing.

test("{§find}: FIND glob body matches entry content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // pathname "doc" contains no "TODO"; only the content does.
        await seed(db, workspaceId, sessionId, [["doc", "alpha\nTODO: ship\nbeta"]]);
        const r = await new Workspace().find(findStmt(url("doc"), glob("TODO*")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

test("{§find}: FIND regex body matches entry content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // pathname "doc" contains no "timeout"; only the content does.
        await seed(db, workspaceId, sessionId, [["doc", "heading\nalpha timeout beta\ncontext"]]);
        const r = await new Workspace().find(findStmt(url("doc"), regex("timeout")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

test("{§scope-slot}: READ <L> slices by line via the marker slot, not the body", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [["lines", "alpha\nbeta\ngamma"]]);
        const stmt: ReadStatement = { metadata: null, op: "READ", aside: null, target: url("lines"), lineMarker: { marks: [2, 2] }, matcher: null, body: null, position: { line: 1, column: 1 } };
        const r = await readThroughScheme("workspace", null, stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /beta/);
        assert.doesNotMatch(r.content ?? "", /alpha|gamma/);
    } finally { db.close(); }
});

// --- FIND: body matcher runs against content ------------------------------
// Each workspace swaps the token between fields: the entry that matches by CONTENT
// is NOT the entry that matches by PATHNAME. The impl selects the content-bearing
// entry — a pathname-matcher would return the other one.

test("{§find}: FIND regex selects entries by content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["alpha", "timeout occurred"], // content matches /timeout/; pathname does not
            ["timeout", "all clear"],      // pathname matches /timeout/; content does not
        ]);
        const r = await new Workspace().find(findStmt(url(""), regex("timeout")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///alpha"]);
    } finally { db.close(); }
});

// A glob body selects entries whose CONTENT matches.
test("{§find}: FIND glob selects entries by content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["france/capital", "Paris is the capital"], // content matches Paris*; pathname does not
            ["Paris/note", "see the capital"],          // pathname matches Paris*; content does not
        ]);
        const r = await new Workspace().find(findStmt(url(""), glob("Paris*")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///france/capital"]);
    } finally { db.close(); }
});

test("{§find}: FIND admits extglob groups and literal at-sign text end to end", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["first", "alpha"],
            ["second", "beta"],
            ["third", "gamma"],
            ["coordinates", "prefix @data/users.json suffix"],
        ]);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });
        const grouped = await new Workspace().find(findStmt(url(""), glob("@(alpha|beta)")), ctx);
        assert.equal(grouped.status, 200);
        assert.deepEqual([...new Set(resourcePaths(grouped))], ["workspace:///first", "workspace:///second"]);

        const literal = await new Workspace().find(findStmt(url(""), glob("@data/users.json")), ctx);
        assert.equal(literal.status, 200);
        assert.deepEqual([...new Set(resourcePaths(literal))], ["workspace:///coordinates"]);
    } finally { db.close(); }
});

// --- FIND with structural dialects (jsonpath/xpath) over native content -------
// The dialects route through the mimetype handlers' deep-json / deep-xml channels; these
// prove they are wired through FIND end-to-end on their native mimetypes (NOT 501).

test("{§find}: FIND JSONPath selects JSON entries by content structure", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // `.json` delimiter → application/json mimetype → the handler's deep-json channel.
        await seed(db, workspaceId, sessionId, [
            ["alice.json", '{"admin":true}'],
            ["bob.json", '{"guest":true}'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "jsonpath", raw: "$.admin" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///alice.json"]);
    } finally { db.close(); }
});

test("{§find}: FIND XPath selects XML entries by content structure", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // `.xml` delimiter → application/xml mimetype → the handler's deep-xml channel.
        await seed(db, workspaceId, sessionId, [
            ["a.xml", "<root><user>admin</user></root>"],
            ["b.xml", "<root><group>x</group></root>"],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "xpath", raw: "//user" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.xml"]);
    } finally { db.close(); }
});

// --- Cross-dialect: the payoff of filtering the deep channels ourselves --------
// process() builds BOTH deepJson and deepXml for every type, and we run the
// dialect against the matching projection — so xpath works on a JSON doc and
// jsonpath on an XML doc. Source mimetype is irrelevant to the dialect.

test("{§find}: FIND XPath selects JSON entries through deepXml", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // JSON content → process() also yields deepXml (`<root><role>…</role></root>`); xpath runs over it.
        await seed(db, workspaceId, sessionId, [
            ["a.json", '{"role":"admin"}'],
            ["b.json", '{"name":"guest"}'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "xpath", raw: "//role" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.json"]);
    } finally { db.close(); }
});

test("{§find}: FIND JSONPath selects XML entries through deepJson", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // XML content → process() also yields deepJson (`…attrs.role`); jsonpath runs over it.
        await seed(db, workspaceId, sessionId, [
            ["a.xml", '<root><user role="admin">x</user></root>'],
            ["b.xml", '<root><user name="guest">x</user></root>'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "jsonpath", raw: "$..role" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.xml"]);
    } finally { db.close(); }
});

test("{§find-result-projection}: FIND ~query selects entries by native text matching", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await new Workspace().edit(editStmt(url("a"), "the french revolution and the storming of the bastille"), ctx);
        await new Workspace().edit(editStmt(url("b"), "a recipe for chocolate cake"), ctx);
        await SearchIndex.maintain(ctx);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "fts", raw: "~french AND revolution" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        assert.equal(resourcePaths(r)[0], "workspace:///a", "markerless full-text FIND returns the matching document");
    } finally { db.close(); }
});
});
