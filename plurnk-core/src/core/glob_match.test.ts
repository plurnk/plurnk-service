import test from "node:test";
import assert from "node:assert/strict";
import { matchesGlob } from "node:path";
import globMatch, { deterministic } from "./glob_match.ts";

// {§membership-glob-in-sql} — the SQL function is node:path.matchesGlob, 1/0 for SQLite, and
// deterministic so the planner may treat it as one.
test("glob_match is matchesGlob with a SQLite boolean", () => {
    assert.equal(deterministic, true);
    for (const [pathname, glob] of [["src/a/b.ts", "src/**/*.ts"], ["docs/x.md", "*.md"], ["docs/x.md", "docs/*"], ["a.ts", "src/**"]] as const) {
        assert.equal(globMatch(pathname, glob), matchesGlob(pathname, glob) ? 1 : 0, `${pathname} against ${glob}`);
    }
    assert.equal(globMatch("src/a/b.ts", "src/**/*.ts"), 1);
    assert.equal(globMatch("a.ts", "src/**"), 0);
});
