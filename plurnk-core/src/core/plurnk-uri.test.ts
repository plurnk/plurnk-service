// Entry authority is an explicit durable coordinate. Namespace schemes fold it,
// resource schemes preserve it, and owner schemes consume it outside entry identity.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "@plurnk/plurnk-contracts";
import { authorityParts, entryCoordinateOf, foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";

test("foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("skills", "/x.md"), "/skills/x.md");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("entryCoordinateOf distinguishes namespace, resource, and owner authority", () => {
    const notes = parsePath("notes://docs/fact.md");
    const agent = parsePath("a2a://researcher/tasks/t-1");
    const worker = parsePath("worker://ada/task");
    assert.ok(notes);
    assert.ok(agent);
    assert.ok(worker);
    assert.deepEqual(entryCoordinateOf(notes, "namespace"), {
        authority: "",
        pathname: "/docs/fact.md",
    });
    assert.deepEqual(entryCoordinateOf(agent, "resource"), {
        authority: "researcher",
        pathname: "/tasks/t-1",
    });
    assert.deepEqual(entryCoordinateOf(worker, "owner"), {
        authority: "",
        pathname: "/task",
    });
});

test("resource entry identity preserves canonical authority, port, and serialized query", () => {
    const target = parsePath("https://Example.org:8443/a%28b%29?b=2&a=1&a=3#preview");
    assert.ok(target);
    assert.deepEqual(entryCoordinateOf(target, "resource"), {
        authority: "example.org:8443",
        pathname: "/a(b)?b=2&a=1&a=3",
    });
});

test("renderAddress renders only the durable entry coordinate", () => {
    assert.equal(renderAddress({ scheme: "notes", authority: "", pathname: "/docs/x.md" }), "notes:///docs/x.md");
    assert.equal(renderAddress({ scheme: "a2a", authority: "researcher", pathname: "/tasks/t-1" }), "a2a://researcher/tasks/t-1");
    assert.equal(renderAddress({ scheme: "https", authority: "example.org:8443", pathname: "/a(b)?x=1" }), "https://example.org:8443/a%28b%29?x=1");
});

test("renderAddress preserves literal and percent-encoded network query parentheses", () => {
    assert.equal(
        renderAddress({
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
        }),
        String.raw`https://example.test/x?literal=\)&encoded=%29`,
    );
});

test("authorityParts projects resource authorities into log target columns", () => {
    assert.deepEqual(authorityParts(""), { hostname: null, port: null });
    assert.deepEqual(authorityParts("example.org:8443"), { hostname: "example.org", port: 8443 });
    assert.deepEqual(authorityParts("[::1]:3044"), { hostname: "[::1]", port: 3044 });
});

test("{§scheme-address-network}: https routes through http and ws routes through wss", () => {
    assert.equal(schemeNameOf(parsePath("https://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("http://example.org/x")), "http");
    assert.equal(schemeNameOf(parsePath("wss://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("ws://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("notes:///fact")), "notes");
});

test("namespace folding remains canonical and renders with an empty authority", () => {
    const stored = foldAuthorityIntoPath("docs", "/x.md");
    assert.equal(stored, "/docs/x.md");
    assert.equal(renderAddress({ scheme: "notes", authority: "", pathname: stored }), "notes:///docs/x.md");
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
