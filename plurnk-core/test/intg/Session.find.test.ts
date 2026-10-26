// Tests for FIND on entry-bearing schemes (SPEC {§find}).

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Workspace from "../../src/schemes/Workspace.ts";
import type { CatalogResource, FindResult } from "../../src/schemes/_entry-find.ts";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx } from "./_scheme.ts";
import type { Db } from "../../src/core/Db.ts";
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§markerless-first-page} — the first page a markerless retrieval is

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

test("{§markerless-first-page} Session.find without a scope returns its first page of resources, every resource when they fit; an explicit <1,-1> is the whole", async () => {
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
