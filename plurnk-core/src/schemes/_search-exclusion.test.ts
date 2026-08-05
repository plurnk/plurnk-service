import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import matchSearchExclusion from "./_search-exclusion.ts";

const KEY = "PLURNK_SERVICE_SEARCH_EXCLUDE";
const prefix = `${KEY}=`;
const defaultLine = readFileSync(new URL("../../.env.defaults", import.meta.url), "utf8")
    .split("\n")
    .find((line) => line.startsWith(prefix));
if (defaultLine === undefined) throw new Error(`${KEY} is absent from plurnk-core/.env.defaults`);
const DEFAULT_LIST = defaultLine.slice(prefix.length);

function withExclusions<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
        return fn();
    } finally {
        if (prior === undefined) delete process.env[KEY];
        else process.env[KEY] = prior;
    }
}

test("{§search-exclusion} #91: repository exclusions apply only to file identities", () => {
    withExclusions("*/dist/*", () => {
        const pathname = "/repo/dist/index.json";
        assert.equal(matchSearchExclusion({ scheme: "file", pathname }), "*/dist/*");
        assert.equal(matchSearchExclusion({ scheme: "https", pathname }), undefined);
        assert.equal(matchSearchExclusion({ scheme: "worker", pathname }), undefined);
    });
});

test("{§search-exclusion} #91: exclusions use the body-glob dialect and return the first matching pattern", () => {
    withExclusions("*.min.*, *.map, chunk-?.js, *.mp[34], */dist/*", () => {
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/dist/app.min.js" }), "*.min.*");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/dist/bundle.js.map" }), "*.map");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/dist/chunk-7.js" }), "chunk-?.js");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/media/song.mp3" }), "*.mp[34]");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/docs/src/dist/index.js" }), "*/dist/*");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/chunks/chunk-77.js" }), undefined);
    });
});

test("{§search-exclusion} #91: basename and path patterns remain anchored", () => {
    withExclusions("go.sum, dist/*", () => {
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/x/go.sum" }), "go.sum");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/x/logo.sum" }), undefined);
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "dist/bundle.js" }), "dist/*");
        assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/repo/dist/bundle.js" }), undefined);
    });
});

test("{§search-exclusion} #91: the shipped table excludes generated drawers without eating source", () => {
    withExclusions(DEFAULT_LIST, () => {
        for (const pathname of [
            "/repo/package-lock.json",
            "/docs/assets/app.5c2f.min.js",
            "/repo/coverage/lcov-report/index.html",
            "/repo/vendor/lib/min.js",
            "/docs/.vuepress/cache/x.js",
            "/app/.nuxt/dist-thing.js",
        ]) {
            assert.notEqual(matchSearchExclusion({ scheme: "file", pathname }), undefined, pathname);
        }
        for (const pathname of [
            "/books/novel.md",
            "/data/records.jsonl",
            "/data/wide.csv",
            "/src/minified-parser.ts",
            "/src/vendors-list.md",
        ]) {
            assert.equal(matchSearchExclusion({ scheme: "file", pathname }), undefined, pathname);
        }
    });
});

test("{§search-exclusion} #91: absent or empty configuration has no hidden fallback", () => {
    for (const value of [undefined, "  "]) {
        withExclusions(value, () => {
            assert.equal(matchSearchExclusion({ scheme: "file", pathname: "/repo/package-lock.json" }), undefined);
        });
    }
});
