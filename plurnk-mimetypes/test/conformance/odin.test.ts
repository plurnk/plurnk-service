import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the odin.ts mapping is flat at the top level (procs are never
// nested), but struct fields and enum constants carry the owning type as
// container — so a type ref inside a field line resolves to the FIELD's
// qualified path ("Lexer.cur"), the innermost emitted def by line
// containment.
const SOURCE = `package main

import "core:fmt"

Token :: struct {
    kind: int,
    next: ^Token,
}

Color :: enum { Red, Green }

Lexer :: struct {
    cur: Token,
    colors: []Color,
}

make_token :: proc(kind: int) -> Token {
    t := Token{ kind = kind }
    return t
}

scan :: proc(lx: ^Lexer, t: Token) -> (Token, bool) {
    fmt.println("StringDecoy")
    next := make_token(1)
    helper(next)
    return next, true
}

helper :: proc(t: Token) {}

g_tok: Token

// CommentDecoy
`;

describe("conformance: text/x-odin defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-odin",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // make_token(1) inside scan joins to the local proc def —
                // exactly the service's (container, name) edge.
                { refName: "make_token", container: "scan" },
                { refName: "helper", container: "scan" },
                // Field type use: container is the field's qualified path.
                { refName: "Token", container: "Lexer.cur" },
            ],
            expectRefs: [
                // Self-referential field type through a pointer wrapper.
                { name: "Token", kind: "type", line: 7, container: "Token.next" },
                { name: "Token", kind: "type", line: 13, container: "Lexer.cur" },
                // Element type of an array wrapper.
                { name: "Color", kind: "type", line: 14, container: "Lexer.colors" },
                // Return type of make_token.
                { name: "Token", kind: "type", line: 17, container: "make_token" },
                // Compound literal — Odin's instantiation idiom.
                { name: "Token", kind: "instantiate", line: 18, container: "make_token" },
                // Pointer param, plain param, and tuple result types of scan.
                { name: "Lexer", kind: "type", line: 22, container: "scan" },
                { name: "Token", kind: "type", line: 22, column: 29, container: "scan" },
                { name: "Token", kind: "type", line: 22, column: 40, container: "scan" },
                // Selector-final call (fmt.println) and bare calls.
                { name: "println", kind: "call", line: 23, container: "scan" },
                { name: "make_token", kind: "call", line: 24, container: "scan" },
                { name: "helper", kind: "call", line: 25, container: "scan" },
                { name: "Token", kind: "type", line: 29, container: "helper" },
                // Top-level var declaration's type; the var def is the
                // innermost (one-line) containing def.
                { name: "Token", kind: "type", line: 31, container: "g_tok" },
            ],
        });
        // Odin imports take collection-path strings, not symbol names — no
        // import refs (SPEC §16 bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Odin");
        assert.ok(!references.some((r) => r.name === "core:fmt" || r.name === "fmt"));
        // No inheritance in Odin.
        assert.ok(!references.some((r) => r.kind === "inherit"), "no inherit refs for Odin");
        // Compound-literal FIELD names are data, not refs.
        assert.ok(!references.some((r) => r.name === "kind" && r.kind === "instantiate"));
    });
});
