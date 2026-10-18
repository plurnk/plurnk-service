// Entry authority is an explicit durable coordinate. Namespace schemes fold it,
// resource schemes preserve it, and owner schemes consume it outside entry identity.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "@plurnk/plurnk-parser";
import { entryAddress, entryCoordinateOf, foldAuthorityIntoPath, missExtensions, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";

test("{§fs-home} file address renderers protect literal home-like names", () => {
    for (const [key, expected] of [["~", "./~"], ["~/x.md", "./~/x.md"], ["~/a(b).md", "./~/a%28b%29.md"], ["~someone/x", "~someone/x"], ["src/~/x", "src/~/x"]] as const) {
        assert.equal(entryAddress("file", "", key), expected);
        assert.equal(renderTarget({ scheme: null, pathname: key }), expected);
        assert.equal(missExtensions("file", entryAddress("file", "", key)).target, expected);
    }
    assert.equal(entryAddress("worker", "alice", "/~/x"), "worker://alice/~/x", "non-file paths are untouched");
    const escaped = entryAddress("file", "", "~/a\\b", "/project");
    assert.equal(escaped, "file:///project/%7E/a%5Cb");
    assert.equal(missExtensions("file", escaped).target, escaped, "a rendered address is not escaped twice");
});

test("{§scheme-address-namespace-fold} foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("skills", "/x.md"), "/skills/x.md");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("{§manifest-authority} {§scheme-address-namespace-fold} entryCoordinateOf distinguishes namespace and resource authority", () => {
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
    assert.deepEqual(entryCoordinateOf(worker, "resource"), {
        authority: "ada",
        pathname: "/task",
    });
});

test("{§scheme-address-network} resource entry identity preserves canonical authority, port, and serialized query", () => {
    const target = parsePath("https://Example.org:8443/a%28b%29?b=2&a=1&a=3#preview");
    assert.ok(target);
    assert.deepEqual(entryCoordinateOf(target, "resource"), {
        authority: "example.org:8443",
        pathname: "/a(b)?b=2&a=1&a=3",
    });
});

test("{§scheme-address} renderAddress renders only the durable entry coordinate", () => {
    assert.equal(renderAddress({ scheme: "notes", authority: "", pathname: "/docs/x.md" }), "notes:///docs/x.md");
    assert.equal(renderAddress({ scheme: "a2a", authority: "researcher", pathname: "/tasks/t-1" }), "a2a://researcher/tasks/t-1");
    assert.equal(renderAddress({ scheme: "https", authority: "example.org:8443", pathname: "/a(b)?x=1" }), "https://example.org:8443/a%28b%29?x=1");
});

test("{§path-parentheses} renderAddress preserves literal and percent-encoded network query parentheses", () => {
    assert.equal(
        renderAddress({
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
        }),
        String.raw`https://example.test/x?literal=\)&encoded=%29`,
    );
});

test("{§scheme-address-network}: http routes through https and ws routes through wss", () => {
    assert.equal(schemeNameOf(parsePath("https://example.org/x")), "https");
    assert.equal(schemeNameOf(parsePath("http://example.org/x")), "https", "plain http folds into the https face (#340)");
    assert.equal(schemeNameOf(parsePath("wss://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("ws://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("notes:///fact")), "notes");
});

test("{§path-parentheses} renderTarget is the non-secret inverse for decomposed operation targets", () => {
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

test("{§path-parentheses} renderTarget round-trips exact URI query and fragment spelling through the target lexer", () => {
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
