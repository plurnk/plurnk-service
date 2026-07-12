import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the go.ts mapping is FLAT (no containers on defs — methods don't
// carry receiver types), so ref containers are the bare names of the
// enclosing func/method/type defs.
const SOURCE = `package main

import (
	"fmt"
	alias "strings"
)

type Base struct{}

type Parser struct {
	Base
	field Shape
	count int
}

type Shape struct{ w int }

func (p *Parser) Parse(input string) Token {
	h := Helper{}
	h.Run(input)
	var s pkg.Other
	return Tokenize(input, s)
}

func Tokenize(s string, sh Shape) Token {
	fmt.Println(s)
	return inner(s)
}

type Token int
type Helper struct{}
func (h Helper) Run(x string) {}
func inner(x string) Token { return 0 }
const decoy = "StringDecoy() should never surface"
// CommentDecoy() should never surface
`;

describe("conformance: text/x-go defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-go",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper{} inside Parse joins to the local struct Helper —
                // exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parse" },
                { refName: "Tokenize", container: "Parse" },
                { refName: "inner", container: "Tokenize" },
            ],
            expectRefs: [
                { name: "Base", kind: "inherit", line: 11, container: "Parser" },
                { name: "Shape", kind: "type", line: 12, container: "Parser" },
                // Pointer receiver type joins the method to its struct.
                { name: "Parser", kind: "type", line: 18, container: "Parse" },
                { name: "Token", kind: "type", line: 18, container: "Parse" },
                { name: "Helper", kind: "instantiate", line: 19, container: "Parse" },
                { name: "Run", kind: "call", line: 20, container: "Parse" },
                // Name side of qualified_type (pkg.Other).
                { name: "Other", kind: "type", line: 21, container: "Parse" },
                { name: "Tokenize", kind: "call", line: 22, container: "Parse" },
                { name: "Shape", kind: "type", line: 25, container: "Tokenize" },
                { name: "Println", kind: "call", line: 26, container: "Tokenize" },
                { name: "inner", kind: "call", line: 27, container: "Tokenize" },
                { name: "Helper", kind: "type", line: 32, container: "Run" },
            ],
        });
        // v1 decision: Go imports are package paths, not symbols — no
        // import refs, even for the aliased import.
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Go");
        assert.ok(!references.some((r) => r.name === "alias" || r.name === "fmt"));
    });
});
