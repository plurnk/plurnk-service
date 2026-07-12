import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `package com.example

import com.example.util.Formatter
import com.example.util.Tokenizer as T
import com.example.other.*

class Parser(val shape: Shape) : Base(), Runnable {
    val field: Shape = makeShape()
    val items: List<Token> = listOf()
    fun parse(input: String): Token {
        val h = Helper()
        h.run(input)
        return tokenize(input)
    }
}
class Helper {
    fun run(x: String) { decoyFree(x) }
}
fun tokenize(s: String): Token? = inner(s)
val decoy = "StringDecoy() should never surface"
// CommentDecoy() should never surface
`;

describe("conformance: text/x-kotlin defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-kotlin",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper() inside Parser.parse joins to the local class
                // Helper — constructor invocation is a call in Kotlin
                // (queries/kotlin.ts header), and the join still lands.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "Formatter", kind: "import", line: 3 },
                // Aliased import captures the ORIGINAL name, not the alias.
                { name: "Tokenizer", kind: "import", line: 4 },
                { name: "Shape", kind: "type", line: 7, container: "Parser" },
                { name: "Base", kind: "inherit", line: 7 },
                { name: "Runnable", kind: "inherit", line: 7 },
                { name: "Shape", kind: "type", line: 8, container: "Parser.field" },
                // Generic property type yields both outer and argument names.
                { name: "List", kind: "type", line: 9, container: "Parser.items" },
                { name: "Token", kind: "type", line: 9, container: "Parser.items" },
                { name: "Token", kind: "type", line: 10, container: "Parser.parse" },
                { name: "Helper", kind: "call", line: 11, container: "Parser.parse" },
                { name: "run", kind: "call", line: 12, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 13, container: "Parser.parse" },
                { name: "decoyFree", kind: "call", line: 17, container: "Helper.run" },
                // Nullable return type (Token?) still yields the type name.
                { name: "Token", kind: "type", line: 19, container: "tokenize" },
                { name: "inner", kind: "call", line: 19, container: "tokenize" },
            ],
        });
        // Wildcard import (`import com.example.other.*`) must not surface —
        // its trailing package segment is not a bindable symbol name.
        assert.ok(!references.some((r) => r.kind === "import" && r.line === 5));
        // Aliased import: the alias binding `T` never surfaces as a ref.
        assert.ok(!references.some((r) => r.name === "T"));
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 8);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
