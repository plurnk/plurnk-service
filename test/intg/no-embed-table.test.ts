// #339 — the shipped NO_EMBED decision table (.env.example — the knob IS the classification,
// mimetypes#47) covers GENERATED DIRECTORIES, not just lockfiles/minified: bench's run20 corpus
// was 98% committed VuePress dist bundles, hash-named (12.5188bbc0.js) so *.min.* never matched.
// FTS-only is the honest treatment — still searchable by keyword, zero vector waste.
import test from "node:test";
import assert from "node:assert/strict";
import { matchNoEmbed } from "@plurnk/plurnk-mimetypes";

test("the shipped table classifies generated-dir junk — the run20 specimen shapes (#339)", () => {
    // the literal run20 offender: hash-named bundle under .vuepress/dist
    assert.ok(matchNoEmbed("/docs/src/.vuepress/dist/assets/js/12.5188bbc0.js"), "hash-named vuepress dist bundle");
    assert.ok(matchNoEmbed("/dist/assets/css/site.8ab3.css"), "top-level dist");
    assert.ok(matchNoEmbed("/pkg/node_modules/lodash/index.js"), "committed node_modules");
    assert.ok(matchNoEmbed("/coverage/lcov-report/index.html"), "coverage output");
    // and the pre-existing classes still hold
    assert.ok(matchNoEmbed("/package-lock.json"), "lockfile");
    assert.ok(matchNoEmbed("/app/bundle.min.js"), "minified");
    // real source is NEVER classified — the filter must not eat the corpus
    assert.equal(matchNoEmbed("/src/distiller.ts"), undefined, "a 'dist' SUBSTRING is not a dist DIRECTORY");
    assert.equal(matchNoEmbed("/docs/guide.md"), undefined, "plain source untouched");
});
