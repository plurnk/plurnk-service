// Non-network scheme authorities fold into the stored pathname. Rendering uses the
// canonical empty-authority form; no retired scheme receives a private inverse.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "@plurnk/plurnk-contracts";
import { entryPathnameOf, foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";

test("foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("skills", "/x.md"), "/skills/x.md");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("entryPathnameOf preserves namespace and network authorities in canonical storage identity", () => {
    const notes = parsePath("notes://docs/fact.md");
    const wikipedia = parsePath("https://en.wikipedia.org/wiki/Igor_Smirnov_%28politician%29");
    assert.ok(notes);
    assert.ok(wikipedia);
    assert.equal(entryPathnameOf(notes), "/docs/fact.md");
    assert.equal(
        entryPathnameOf(wikipedia),
        "/en.wikipedia.org/wiki/Igor_Smirnov_(politician)",
    );
});

test("network entry identity includes non-default port and serialized query", () => {
    const target = parsePath("https://Example.org:8443/a%28b%29?b=2&a=1&a=3#preview");
    assert.ok(target);
    assert.equal(entryPathnameOf(target), "/example.org:8443/a(b)?b=2&a=1&a=3");
});

test("renderAddress gives retired and arbitrary non-network schemes no private rendering rule", () => {
    assert.equal(renderAddress("plurnk", "/docs/x.md"), "plurnk:///docs/x.md");
    assert.equal(renderAddress("notes", "/docs/x.md"), "notes:///docs/x.md");
});

test("{§network-address}: network schemes restore authority while namespaces retain :///", () => {
    assert.equal(renderAddress("notes", "/france/capital"), "notes:///france/capital");
    // {§scheme-address} — the folded first segment renders as the network host.
    assert.equal(renderAddress("http", "/en.wikipedia.org/wiki/Paris"), "http://en.wikipedia.org/wiki/Paris");
    assert.equal(
        renderAddress("https", "/en.wikipedia.org/wiki/Igor_Smirnov_(politician)"),
        "https://en.wikipedia.org/wiki/Igor_Smirnov_%28politician%29",
        "model-facing addresses encode target delimiters",
    );
});

test("{§scheme-address-network}: https routes through http and ws routes through wss", () => {
    assert.equal(schemeNameOf(parsePath("https://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("http://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("wss://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("ws://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("notes:///fact")), "notes");
});

test("{§network-address}: ws and wss render authority like http and https", () => {
    assert.equal(renderAddress("ws", "/example.org/socket"), "ws://example.org/socket");
    assert.equal(renderAddress("wss", "/example.org/socket"), "wss://example.org/socket");
});

test("fold then render canonicalizes a non-network authority into the pathname", () => {
    const stored = foldAuthorityIntoPath("docs", "/x.md");
    assert.equal(stored, "/docs/x.md");
    assert.equal(renderAddress("notes", stored), "notes:///docs/x.md");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), stored);
});

test("renderTarget is the non-secret inverse for decomposed operation targets", () => {
    assert.equal(renderTarget({
        scheme: "https",
        hostname: "example.org",
        port: 8443,
        pathname: "/a(b)",
        query: "b=(2)&a=%281%29&a=3",
        fragment: "pre(view)",
    }), String.raw`https://example.org:8443/a%28b%29?b=\(2\)&a=%281%29&a=3#pre\(view\)`);
    assert.equal(renderTarget({
        scheme: "worker",
        hostname: "ada",
        port: null,
        pathname: "/task",
        query: null,
        fragment: null,
    }), "worker://ada/task");
    assert.equal(renderTarget({
        scheme: null,
        pathname: "/docs/a(b).md",
    }), "docs/a%28b%29.md");
});

test("renderTarget round-trips exact URI query and fragment spelling through the target lexer", () => {
    const rendered = renderTarget({
        scheme: "https",
        hostname: "example.org",
        pathname: "/x",
        query: "literal=)&encoded=%29&slash=\\",
        fragment: "preview(\\",
    });
    assert.equal(
        rendered,
        String.raw`https://example.org/x?literal=\)&encoded=%29&slash=\\#preview\(\\`,
    );
    const parsed = parsePath(rendered ?? "");
    if (parsed?.kind !== "url") assert.fail("expected rendered URL target");
    assert.equal(parsed.query, "literal=)&encoded=%29&slash=\\");
    assert.equal(parsed.fragment, "preview(\\");
});
