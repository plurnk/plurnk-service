import test from "node:test";
import assert from "node:assert/strict";
import globMatch, { deterministic } from "./glob_match.ts";

test("{§membership-glob-in-sql} the deterministic predicate preserves escapes and segment boundaries", () => {
    assert.equal(deterministic, true);
    for (const [pathname, glob, expected] of [
        ["src/a/b.ts", "src/**/*.ts", 1],
        ["docs/x.md", "*.md", 0],
        ["docs/x.md", "docs/*", 1],
        ["a.ts", "src/**", 0],
        ["a*.txt", String.raw`a\*.txt`, 1],
        ["a/b.txt", String.raw`a\*.txt`, 0],
        [String.raw`dir\name/a.txt`, String.raw`dir\\name/*.txt`, 1],
        ["dir/name/a.txt", String.raw`dir\\name/*.txt`, 0],
    ] as const) {
        assert.equal(globMatch(pathname, glob), expected, `${pathname} against ${glob}`);
    }
});
