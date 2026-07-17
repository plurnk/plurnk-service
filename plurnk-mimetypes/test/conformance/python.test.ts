import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `from collections import OrderedDict
from helpers import shape as sh
import os.path

class Parser(Base, mixins.Runnable):
    field: Shape = None

    def parse(self, text: str) -> Token:
        h = Helper()
        h.run(text)
        return tokenize(text)

class Helper:
    def run(self, x: str) -> None:
        cleanup(os.path.join(x))

def tokenize(s: str) -> Token:
    return inner(s)

DECOY = "StringDecoy() should never surface"
# CommentDecoy() should never surface
`;

describe("conformance: text/x-python defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-python",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                // (Instantiation is syntactically a call in Python.)
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "OrderedDict", kind: "import", line: 1 },
                { name: "shape", kind: "import", line: 2 },
                { name: "path", kind: "import", line: 3 },
                { name: "Base", kind: "inherit", line: 5 },
                { name: "Runnable", kind: "inherit", line: 5 },
                { name: "Shape", kind: "type", line: 6, container: "Parser.field" },
                { name: "str", kind: "type", line: 8, container: "Parser.parse" },
                { name: "Token", kind: "type", line: 8, container: "Parser.parse" },
                { name: "Helper", kind: "call", line: 9, container: "Parser.parse" },
                { name: "run", kind: "call", line: 10, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 11, container: "Parser.parse" },
                // Nested attribute chain: only the outermost callee name.
                { name: "cleanup", kind: "call", line: 15, container: "Helper.run" },
                { name: "join", kind: "call", line: 15, container: "Helper.run" },
                { name: "inner", kind: "call", line: 18, container: "tokenize" },
            ],
        });
        // Aliased imports capture the original names, never the aliases.
        assert.ok(!references.some((r) => r.name === "sh"), "alias 'sh' must not surface");
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 6);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
