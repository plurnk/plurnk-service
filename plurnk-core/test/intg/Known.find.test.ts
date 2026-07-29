// Tests for FIND on entry-bearing schemes (SPEC §find).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const editStmt = (target: UrlPath, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

const seedEntries = async (db: import("../../src/core/Db.ts").Db, workspaceId: number, workerId: number, entries: Array<[string, string, string[]?]>) => {
    const k = new Worker();
    for (const [pathname, body, tags] of entries) {
        await k.edit(editStmt(url(pathname), body, tags ?? null), makeSchemeCtx({ db, workspaceId, workerId }));
    }
};

test("Known.find returns the scheme's catalog rows (JSON), filtered to matches", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["a", "alpha"], ["b", "beta"], ["c", "gamma"],
        ]);
        const r = await new Worker().find(findStmt(url("")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        // FIND is the filtered catalog: a JSON array of catalog rows (path + per-channel
        // {mimetype, tokens, lines}), not one row per finding.
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(r.results.map((row) => row.path), ["worker:///a", "worker:///b", "worker:///c"]);
        assert.deepEqual(JSON.parse(r.content!), r.results, "content is the JSON serialization of the catalog rows");
        const [first] = r.results;
        assert.ok(first !== undefined && first.channels !== undefined);
        assert.equal(first.path, "worker:///a");
        assert.deepEqual(Object.keys(first.channels), ["worker:///a"], "the default channel keys by the bare entry path");
        assert.equal(typeof first.channels["worker:///a"].mimetype, "string");
        assert.equal(first.channels["worker:///a"].lines, 1, "\"alpha\" is one line");
        assert.equal(typeof first.channels["worker:///a"].tokens, "number");
        assert.ok(!("extent" in (first as object)), "a catalog row carries no legacy extent");
    } finally { db.close(); }
});

test("Known.find with scope prefix filters to that subtree", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["plan/step1", "x"], ["plan/step2", "y"], ["other/thing", "z"],
        ]);
        const r = await new Worker().find(findStmt(url("plan/")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///plan/step1", "worker:///plan/step2"]);
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
        assert.deepEqual(root.results.map((item) => item.path), [
            "worker:///.env.defaults",
            "worker:///.github/**",
            "worker:///docs/**",
            "worker:///README.md",
            "worker:///src/**",
        ]);
        const src = root.results.find((item) => item.path === "worker:///src/**");
        assert.ok(src !== undefined && "items" in src, "the directory is a scope summary, not a fake entry");
        assert.equal(src.items, 3, "the summary counts every descendant recursively, including dot entries");
        assert.ok((src.tokens ?? 0) > 0, "the summary reports the recursive subtree's READ weight");
        assert.deepEqual(root.matches.map((match) => match.pathname), ["/.env.defaults", "/README.md"], "folder summaries never become hidden READ fan-out matches");

        const drilled = await worker.find(findStmt(url("src/*")), ctx);
        assert.deepEqual(drilled.results.map((item) => item.path), [
            "worker:///src/.hidden.ts",
            "worker:///src/index.ts",
            "worker:///src/lib/**",
        ]);

        const dotDrill = await worker.find(findStmt(url(".github/**")), ctx);
        assert.deepEqual(dotDrill.results.map((item) => item.path), ["worker:///.github/workflows/ci.yml"]);

        const recursive = await worker.find(findStmt(url("**")), ctx);
        assert.deepEqual(recursive.results.map((item) => item.path), [
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
        assert.deepEqual(oneLevel.results.map((item) => item.path), ["worker:///src/direct.ts"], "`*` never crosses `/`");

        const question = await worker.find(findStmt(url("src/nested/deep.?s")), ctx);
        assert.deepEqual(question.results.map((item) => item.path), ["worker:///src/nested/deep.ts"], "`?` matches one non-separator character");

        const recursive = await worker.find(findStmt(url("src/**/*.ts")), ctx);
        assert.deepEqual(recursive.results.map((item) => item.path), [
            "worker:///src/direct.ts",
            "worker:///src/nested/deep.ts",
        ], "`**` crosses directories");

        const braces = await worker.find(findStmt(url("**/*.{go,ts}")), ctx);
        assert.deepEqual(braces.results.map((item) => item.path), [
            "worker:///root.ts",
            "worker:///src/direct.ts",
            "worker:///src/nested/deep.go",
            "worker:///src/nested/deep.ts",
        ], "shell brace patterns are resolved by the native path matcher, not SQLite GLOB");
    } finally { db.close(); }
});

test("Known.find with glob matcher filters by CONTENT", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Pathnames are neutral (a/b/c); the matchable token lives in the content.
        await seedEntries(db, workspaceId, workerId, [
            ["a", "france is the topic"], ["b", "france and germany"], ["c", "italy only"],
        ]);
        const r = await new Worker().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("a content match emits one item per resource with match coordinates", async () => {
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
        const byPath = new Map(r.results.map((row) => [row.path, row] as const));
        assert.deepEqual(byPath.get("worker:///a")?.matches, [{ lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3 }]);
        assert.deepEqual(byPath.get("worker:///b")?.matches, [{ lineStart: 2, lineEnd: 2, rowStart: 2, rowEnd: 2 }]);
        assert.equal(byPath.has("worker:///c"), false, "a miss excludes the entry entirely — no item");
    } finally { db.close(); }
});

test("Known.find with tag filter — AND semantics", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["a", "x", ["urgent", "europe"]],
            ["b", "y", ["urgent"]],
            ["c", "z", ["europe"]],
            ["d", "w", ["urgent", "europe", "answer"]],
        ]);
        // Both tags must be present
        const r = await new Worker().find(findStmt(url(""), null, ["urgent", "europe"]), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a", "worker:///d"]);
    } finally { db.close(); }
});

test("Known.find combining glob (content) + tag filter", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [
            ["s1", "plan alpha", ["urgent"]],
            ["s2", "plan beta", ["later"]],
            ["s3", "other thing", ["urgent"]],
        ]);
        // glob matches content "plan*"; tag narrows to urgent → only s1 satisfies both.
        const r = await new Worker().find(findStmt(url(""), glob("plan*"), ["urgent"]), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///s1"]);
    } finally { db.close(); }
});

test("Known.find with regex matcher filters by CONTENT", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "alpha"], ["b", "beta"], ["c", "aardvark"]]);
        const r = await new Worker().find(findStmt(url(""), regex("^a")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))].toSorted(), ["worker:///a", "worker:///c"]);
    } finally { db.close(); }
});

test("Known.find preserves an invalid matcher's parser cause and recovery facts", async () => {
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

test("Known.find regex honors flags — case-insensitive (i) on content", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "Alpha"], ["b", "alpine"], ["c", "beta"]]);
        // `i` must match "Alpha" (capital A) against /^al/ — the flag crosses into
        // the plugin's content regex; without it, `^al` would skip "Alpha".
        const ci: MatcherBody = { dialect: "regex", raw: "/^al/i", pattern: "^al", flags: "i" };
        const r = await new Worker().find(findStmt(url(""), ci), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("Known.find regex accepts `g` flag on content (no throw)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "foo here"], ["b", "a foo"], ["c", "bar"]]);
        // `g` doesn't change hit/no-hit for entry selection; it must not throw.
        const g: MatcherBody = { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" };
        const r = await new Worker().find(findStmt(url(""), g), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))].toSorted(), ["worker:///a", "worker:///b"]);
    } finally { db.close(); }
});

test("Known.find regex `y` (sticky) anchors at content start", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "foobar"], ["b", "a foobar"]]);
        // sticky → match only at position 0 of the content, not anywhere.
        const y: MatcherBody = { dialect: "regex", raw: "/foo/y", pattern: "foo", flags: "y" };
        const r = await new Worker().find(findStmt(url(""), y), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a"]);
    } finally { db.close(); }
});

test("Known.find xpath matcher with no structural match → entry excluded (200, empty)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // xpath runs over the markdown deepXml; `//x` matches no element →
        // no content hit → excluded.
        await seedEntries(db, workspaceId, workerId, [["a", "plain text"]]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "xpath", raw: "//x" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
    } finally { db.close(); }
});

test("Known.find with <L> paginates results", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
        const stmt: ReturnType<typeof findStmt> = { ...findStmt(url(""), null), lineMarker: { marks: [2, 3] } };
        const r = await new Worker().find(stmt, makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///b", "worker:///c"]);
    } finally { db.close(); }
});

test("Known.find with no matches returns 200 with empty results", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedEntries(db, workspaceId, workerId, [["a", "x"]]);
        const r = await new Worker().find(findStmt(url(""), glob("nope*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], []);
        assert.equal(r.content, "[]", "no matches → an empty JSON array");
    } finally { db.close(); }
});

test("Known.find names a zero-match selection before rejecting its requested range", async () => {
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
        assert.equal(result.status, 416);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/worker/selection-range-unavailable");
        assert.equal(result.problem?.stage, "selection");
        assert.equal(result.problem?.dialect, "glob");
        assert.equal(result.problem?.matchedResources, 0);
        assert.deepEqual(result.problem?.range, {
            unit: "result",
            requested: { first: 30, last: 100 },
            available: { first: null, last: null, total: 0 },
        });
        assert.equal(
            result.problem?.detail,
            "The glob matcher selected 0 resources; <30,100> cannot select from an empty result set.",
        );
        assert.equal(
            result.problem?.recovery,
            "Correct or remove the matcher before choosing a range.",
        );
        assert.equal(result.problem?.retryable, false);
    } finally { db.close(); }
});

test("Known.find is scoped to the workspace (doesn't leak across workspaces)", async () => {
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
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///here"], "only entries from this workspace");
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
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///here-commons"], "the commons FIND never leaks another scheme's entries");
    } finally { db.close(); }
});
