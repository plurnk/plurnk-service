// #339 — the shipped SEARCH_EXCLUDE decision table (.env.defaults — the knob IS the classification,
// mimetypes#47) covers GENERATED DIRECTORIES, not just lockfiles/minified: bench's run20 corpus
// was 98% committed VuePress dist bundles, hash-named (12.5188bbc0.js) so *.min.* never matched.
// These remain directly readable but are absent from graph, lexical, and vector recall.
import test from "node:test";
import assert from "node:assert/strict";
import { matchSearchExclusion } from "@plurnk/plurnk-mimetypes";

test("the shipped table classifies generated-dir junk — the run20 specimen shapes (#339)", () => {
    // the literal run20 offender: hash-named bundle under .vuepress/dist
    assert.ok(matchSearchExclusion("/docs/src/.vuepress/dist/assets/js/12.5188bbc0.js"), "hash-named vuepress dist bundle");
    assert.ok(matchSearchExclusion("/dist/assets/css/site.8ab3.css"), "top-level dist");
    assert.ok(matchSearchExclusion("/pkg/node_modules/lodash/index.js"), "committed node_modules");
    assert.ok(matchSearchExclusion("/coverage/lcov-report/index.html"), "coverage output");
    // and the pre-existing classes still hold
    assert.ok(matchSearchExclusion("/package-lock.json"), "lockfile");
    assert.ok(matchSearchExclusion("/app/bundle.min.js"), "minified");
    // real source is NEVER classified — the filter must not eat the corpus
    assert.equal(matchSearchExclusion("/src/distiller.ts"), undefined, "a 'dist' SUBSTRING is not a dist DIRECTORY");
    assert.equal(matchSearchExclusion("/docs/guide.md"), undefined, "plain source untouched");
});
