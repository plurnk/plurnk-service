// The plurnk:// addressing convention (plurnk-uri.ts): a namespace lives in the URL authority
// slot, but storage keys by the full folded path. fold (parse) and render (the inverse) must
// round-trip, and a single-segment singleton must stay empty-authority root.

import test from "node:test";
import assert from "node:assert/strict";
import { foldAuthorityIntoPath, renderAddress } from "./plurnk-uri.ts";

test("foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("prompt", "/7/3"), "/prompt/7/3");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("renderAddress promotes a multi-segment plurnk path to authority form", () => {
    assert.equal(renderAddress("plurnk", "/docs/x.md"), "plurnk://docs/x.md");
    assert.equal(renderAddress("plurnk", "/prompt/7/3"), "plurnk://prompt/7/3");
});

test("renderAddress keeps a single-segment plurnk singleton at empty-authority root", () => {
    assert.equal(renderAddress("plurnk", "/manifest.json"), "plurnk:///manifest.json");
    assert.equal(renderAddress("plurnk", "/POLICY.md"), "plurnk:///POLICY.md");
});

test("renderAddress: known keeps empty-authority :///; url schemes take the authority form (#370)", () => {
    assert.equal(renderAddress("known", "/france/capital"), "known:///france/capital");
    // A folded-authority web address renders the authority form — the first segment IS the host
    // (the run42 sweep caught https:///en.wikipedia.org minted into packets).
    assert.equal(renderAddress("http", "/en.wikipedia.org/wiki/Paris"), "http://en.wikipedia.org/wiki/Paris");
});

test("fold then render round-trips a model-emitted authority-form address", () => {
    // model writes plurnk://docs/x.md → grammar parses hostname="docs", pathname="/x.md"
    const stored = foldAuthorityIntoPath("docs", "/x.md");
    assert.equal(stored, "/docs/x.md");
    assert.equal(renderAddress("plurnk", stored), "plurnk://docs/x.md");
    // the empty-authority form folds to the SAME canonical key — both addressings agree
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), stored);
});
