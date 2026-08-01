// The plurnk:// addressing convention (plurnk-uri.ts): a namespace lives in the URL authority
// slot, but storage keys by the full folded path. fold (parse) and render (the inverse) must
// round-trip, and a single-segment singleton must stay empty-authority root.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "@plurnk/plurnk-contracts/grammar";
import { entryPathnameOf, foldAuthorityIntoPath, renderAddress, schemeNameOf } from "./plurnk-uri.ts";

test("foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("skills", "/x.md"), "/skills/x.md");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("entryPathnameOf preserves namespace and network authorities in canonical storage identity", () => {
    const known = parsePath("known://docs/fact.md");
    const wikipedia = parsePath("https://en.wikipedia.org/wiki/Igor_Smirnov_%28politician%29");
    assert.ok(known);
    assert.ok(wikipedia);
    assert.equal(entryPathnameOf(known), "/docs/fact.md");
    assert.equal(
        entryPathnameOf(wikipedia),
        "/en.wikipedia.org/wiki/Igor_Smirnov_(politician)",
    );
});

test("renderAddress promotes a multi-segment plurnk path to authority form", () => {
    assert.equal(renderAddress("plurnk", "/docs/x.md"), "plurnk://docs/x.md");
    assert.equal(renderAddress("plurnk", "/skills/x.md"), "plurnk://skills/x.md");
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
    assert.equal(
        renderAddress("https", "/en.wikipedia.org/wiki/Igor_Smirnov_(politician)"),
        "https://en.wikipedia.org/wiki/Igor_Smirnov_%28politician%29",
        "model-facing addresses encode target delimiters",
    );
});

test("schemeNameOf: https rides http; ws rides wss — two first-class schemes, one package (#473)", () => {
    assert.equal(schemeNameOf(parsePath("https://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("http://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("wss://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("ws://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("known:///fact")), "known");
});

test("renderAddress: ws/wss render the authority form like http/https (#470)", () => {
    assert.equal(renderAddress("ws", "/example.org/socket"), "ws://example.org/socket");
    assert.equal(renderAddress("wss", "/example.org/socket"), "wss://example.org/socket");
});

test("fold then render round-trips a model-emitted authority-form address", () => {
    // model writes plurnk://docs/x.md → grammar parses hostname="docs", pathname="/x.md"
    const stored = foldAuthorityIntoPath("docs", "/x.md");
    assert.equal(stored, "/docs/x.md");
    assert.equal(renderAddress("plurnk", stored), "plurnk://docs/x.md");
    // the empty-authority form folds to the SAME canonical key — both addressings agree
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), stored);
});
