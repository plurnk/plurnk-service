// Tests for FIND on entry-bearing schemes (SPEC {§find}).

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import type { CatalogResource, FindResult } from "../../src/schemes/_entry-find.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, target, lineMarker: null, body,
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
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

const seedEntries = async (db: import("../../src/core/Db.ts").Db, workspaceId: number, workerId: number, entries: Array<[string, string]>) => {
    const k = new Worker();
    for (const [pathname, body] of entries) {
        await k.edit(editStmt(url(pathname), body), makeSchemeCtx({ db, workspaceId, workerId }));
    }
};

test("Worker.find returns the scheme's catalog groups (JSON), filtered to matches", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["a", "alpha"], ["b", "beta"], ["c", "gamma"],
        ]);
        const r = await new Worker().find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        // FIND is the filtered catalog: one default-first channel array per resource.
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(paths(r), ["worker:///a", "worker:///b", "worker:///c"]);
        assert.deepEqual(JSON.parse(r.content!), r.results, "content is the JSON serialization of the catalog groups");
        const renderedRows = r.content!.split("\n");
        assert.equal(renderedRows.length, r.results.length, "each FIND result ordinal owns one physical JSON line");
        assert.match(renderedRows[0], /^\[\[\{"path":"worker:\/\/\/a"/);
        assert.match(renderedRows[1], /^\[\{"path":"worker:\/\/\/b"/);
        assert.match(renderedRows[2], /^\[\{"path":"worker:\/\/\/c".*\}\]\]$/);
        const [first] = resources(r);
        assert.ok(first !== undefined);
        assert.equal(first.length, 1, "a single-channel resource is a one-element group");
        assert.equal(first[0].path, "worker:///a");
        assert.ok("mimetype" in first[0], "an entry group contains channels, not a scope summary");
        assert.equal(typeof first[0].mimetype, "string");
        assert.equal(first[0].lines, 1, "\"alpha\" is one line");
        assert.equal(typeof first[0].tokens, "number");
        assert.ok(!("extent" in first[0]), "a catalog channel carries no legacy extent");
    } finally { db.close(); }
});

test("Worker.find with scope prefix filters to that subtree", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["plan/step1", "x"], ["plan/step2", "y"], ["other/thing", "z"],
        ]);
        const r = await new Worker().find(findStmt(url("plan/")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///plan/step1", "worker:///plan/step2"]);
    } finally { db.close(); }
});

test("a single-star path glob lists one level with actionable recursive folder summaries", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            [".env.defaults", "defaults"],
            [".github/workflows/ci.yml", "workflow"],
            ["README.md", "root"],
            ["src/.hidden.ts", "hidden child"],
            ["src/index.ts", "direct child"],
            ["src/lib/deep.ts", "nested child"],
            ["docs/guide.md", "guide"],
        ]);
        const worker = new Worker();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 });

        const root = await worker.find(findStmt(url("*")), ctx);
        assert.equal(root.status, 200);
        assert.deepEqual(paths(root), [
            "worker:///.env.defaults",
            "worker:///.github/**",
            "worker:///docs/**",
            "worker:///README.md",
            "worker:///src/**",
        ]);
        const src = resources(root).find(([item]) => item.path === "worker:///src/**");
        assert.ok(src !== undefined && "items" in src[0], "the directory is a one-element scope group, not a fake entry");
        assert.equal(src[0].items, 3, "the summary counts every descendant recursively, including dot entries");
        assert.ok(src[0].tokens > 0, "the summary reports the recursive subtree's READ weight");
        assert.equal(root.matchingPathCount, 2, "folder summaries never become matching resource paths");

        const drilled = await worker.find(findStmt(url("src/*")), ctx);
        assert.deepEqual(paths(drilled), [
            "worker:///src/.hidden.ts",
            "worker:///src/index.ts",
            "worker:///src/lib/**",
        ]);

        const dotDrill = await worker.find(findStmt(url(".github/**")), ctx);
        assert.deepEqual(paths(dotDrill), ["worker:///.github/workflows/ci.yml"]);

        const recursive = await worker.find(findStmt(url("**")), ctx);
        assert.deepEqual(paths(recursive), [
            "worker:///.env.defaults",
            "worker:///.github/workflows/ci.yml",
            "worker:///README.md",
            "worker:///docs/guide.md",
            "worker:///src/.hidden.ts",
            "worker:///src/index.ts",
            "worker:///src/lib/deep.ts",
        ], "double-star remains the complete recursive entry listing, dot entries included and without summary noise");
    } finally { db.close(); }
});

test("path globs use shell segment semantics and support native brace patterns", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["root.ts", "root"],
            ["src/direct.ts", "direct"],
            ["src/nested/deep.ts", "deep"],
            ["src/nested/deep.go", "go"],
        ]);
        const worker = new Worker();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 });

        const oneLevel = await worker.find(findStmt(url("src/*.ts")), ctx);
        assert.deepEqual(paths(oneLevel), ["worker:///src/direct.ts"], "`*` never crosses `/`");

        const question = await worker.find(findStmt(url("src/nested/deep.?s")), ctx);
        assert.deepEqual(paths(question), ["worker:///src/nested/deep.ts"], "`?` matches one non-separator character");

        const recursive = await worker.find(findStmt(url("src/**/*.ts")), ctx);
        assert.deepEqual(paths(recursive), [
            "worker:///src/direct.ts",
            "worker:///src/nested/deep.ts",
        ], "`**` crosses directories");

        const braces = await worker.find(findStmt(url("**/*.{go,ts}")), ctx);
        assert.deepEqual(paths(braces), [
            "worker:///root.ts",
            "worker:///src/direct.ts",
            "worker:///src/nested/deep.go",
            "worker:///src/nested/deep.ts",
        ], "shell brace patterns are resolved by the native path matcher, not SQLite GLOB");
    } finally { db.close(); }
});

test("Worker.find with glob matcher filters by CONTENT", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Pathnames are neutral (a/b/c); the matchable token lives in the content.
        await seedEntries(db, workspaceId, workerId, [
            ["a", "france is the topic"], ["b", "france and germany"], ["c", "italy only"],
        ]);
        const r = await new Worker().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("a broad content match emits one item per resource with location counts", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Multi-line content: the match sits on line 3 of a, line 2 of b; c never matches.
        await seedEntries(db, workspaceId, workerId, [
            ["a", "intro\nbody\nfrance is here\ntail"],
            ["b", "header\nfrance again\nmore"],
            ["c", "italy only\nspain too"],
        ]);
        const r = await new Worker().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        const byPath = new Map(resources(r).map(([row]) => [row.path, row] as const));
        assert.equal(byPath.get("worker:///a")?.matchLocationCount, 1);
        assert.equal(byPath.get("worker:///b")?.matchLocationCount, 1);
        assert.equal(r.matchLocationCount, 2);
        assert.equal(byPath.has("worker:///c"), false, "a miss excludes the entry entirely — no item");
    } finally { db.close(); }
});

test("Worker.find signal does not filter resource candidates", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["a", "x"],
            ["b", "y"],
            ["c", "z"],
            ["d", "w"],
        ]);
        const r = await new Worker().find(findStmt(url(""), null, ["+urgent", "+europe"]), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///a", "worker:///b", "worker:///c", "worker:///d"]);
    } finally { db.close(); }
});

test("Worker.find signal leaves matcher selection unchanged", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["s1", "plan alpha"],
            ["s2", "plan beta"],
            ["s3", "other thing"],
        ]);
        const r = await new Worker().find(findStmt(url(""), glob("plan*"), ["+urgent"]), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///s1", "worker:///s2"]);
    } finally { db.close(); }
});

test("Worker.find with regex matcher filters by CONTENT", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "alpha"], ["b", "beta"], ["c", "aardvark"]]);
        const r = await new Worker().find(findStmt(url(""), regex("^a")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["worker:///a", "worker:///c"]);
    } finally { db.close(); }
});

test("Worker.find preserves an invalid matcher's parser cause and recovery facts", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a.json", "{\"answer\":42}"]]);
        const r = await new Worker().find(
            findStmt(url(""), { dialect: "jsonpath", raw: "$.[" }),
            makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }),
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "jsonpath");
        assert.equal(r.problem?.recovery, "Correct or remove the matcher.");
        assert.equal(r.problem?.retryable, false);
        assert.doesNotMatch(
            r.problem?.detail ?? "",
            /could not resolve the requested selection/,
            "the parser's actual cause survives the FIND boundary",
        );
    } finally {
        db.close();
    }
});

test("Worker.find regex honors flags — case-insensitive (i) on content", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "Alpha"], ["b", "alpine"], ["c", "beta"]]);
        // `i` must match "Alpha" (capital A) against /^al/ — the flag crosses into
        // the plugin's content regex; without it, `^al` would skip "Alpha".
        const ci: MatcherBody = { dialect: "regex", raw: "/^al/i", pattern: "^al", flags: "i" };
        const r = await new Worker().find(findStmt(url(""), ci), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("Worker.find regex accepts `g` flag on content (no throw)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "foo here"], ["b", "a foo"], ["c", "bar"]]);
        // `g` doesn't change hit/no-hit for entry selection; it must not throw.
        const g: MatcherBody = { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" };
        const r = await new Worker().find(findStmt(url(""), g), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("Worker.find regex `y` (sticky) anchors at content start", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "foobar"], ["b", "a foobar"]]);
        // sticky → match only at position 0 of the content, not anywhere.
        const y: MatcherBody = { dialect: "regex", raw: "/foo/y", pattern: "foo", flags: "y" };
        const r = await new Worker().find(findStmt(url(""), y), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///a"]);
    } finally { db.close(); }
});

test("Worker.find xpath matcher with no structural match → 204", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // xpath runs over the markdown deepXml; `//x` matches no element →
        // no content hit → excluded.
        await seedEntries(db, workspaceId, workerId, [["a", "plain text"]]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "xpath", raw: "//x" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 204);
        assert.deepEqual([...new Set(paths(r))], []);
    } finally { db.close(); }
});

test("Worker.find with <L> paginates results", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
        const stmt: ReturnType<typeof findStmt> = { ...findStmt(url(""), null), lineMarker: { marks: [2, 3] } };
        const r = await new Worker().find(stmt, makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///b", "worker:///c"]);
        const one = await new Worker().find(
            { ...findStmt(url(""), null), lineMarker: { marks: [2] } },
            makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }),
        );
        assert.equal(one.results.length, 1);
        assert.doesNotMatch(one.content!, /\n/, "a single result remains one compact JSON line");
    } finally { db.close(); }
});

test("Worker.find markerless selection returns the first 16 with a compact selection extent", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const entries = Array.from({ length: 20 }, (_, index): [string, string] => [
            `entry-${String(index + 1).padStart(2, "0")}`,
            `content ${index + 1}`,
        ]);
        await seedEntries(db, workspaceId, workerId, entries);
        const worker = new Worker();
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 });
        const bounded = await worker.find(findStmt(url("")), ctx);
        assert.equal(bounded.results.length, 16);
        assert.equal(bounded.range?.total, 20);
        assert.deepEqual(bounded.range?.returned, [1, 16]);
        assert.ok(bounded.itemsTokenTotal > bounded.returnedItemsTokenTotal);

        const all = await worker.find(
            { ...findStmt(url("")), lineMarker: { marks: [1, -1] } },
            ctx,
        );
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.itemsTokenTotal, all.returnedItemsTokenTotal);
    } finally { db.close(); }
});

test("Worker.find with no matches returns an empty 204 result", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "x"]]);
        const r = await new Worker().find(findStmt(url(""), glob("nope*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.deepEqual(r, {
            status: 204,
            content: null,
            mimetype: null,
            results: [],
            itemsTokenTotal: 0,
            returnedItemsTokenTotal: 0,
            matchingPathCount: 0,
            matchLocationCount: 0,
            range: {
                unit: "resource",
                total: 0,
                requested: [1, 16],
            },
        });
    } finally { db.close(); }
});

test("Worker.find reports a matcher miss before applying result pagination", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "alpha"], ["b", "beta"]]);
        const statement: FindStatement = {
            ...findStmt(url(""), glob("nope*")),
            lineMarker: { marks: [30, 100] },
        };
        const result = await new Worker().find(
            statement,
            makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }),
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

test("Worker.find is scoped to the workspace (doesn't leak across workspaces)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Seed in this workspace
        await seedEntries(db, workspaceId, workerId, [["here", "x"]]);

        // Create another workspace and seed there
        const otherWorkspaceId = await insertWorkspace(db, "other-workspace");
        const otherWorkerId = await insertWorker(db, otherWorkspaceId);
        const k = new Worker();
        await k.edit(editStmt(url("elsewhere"), "y"), makeSchemeCtx({ db, workspaceId: otherWorkspaceId, workerId: otherWorkerId }));

        const r = await k.find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///here"], "only entries from this workspace");
    } finally { db.close(); }
});

test("commons FIND is scoped to the scheme (doesn't leak across schemes)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["here-commons", "x"]]);

        // Seed a SKILL entry under the same workspace — a different scheme at the same tier.
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit({ ...editStmt(url("here-skill"), "y"), target: { ...url("here-skill"), scheme: "skill", raw: "skill:///here-skill" } }, makeHandlerCtx(makeSchemeCtx({ db, workspaceId, workerId }), Skill.manifest));

        const r = await new Worker().find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(paths(r))], ["worker:///here-commons"], "the commons FIND never leaks another scheme's entries");
    } finally { db.close(); }
});
