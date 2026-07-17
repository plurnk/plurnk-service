import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `import java.util.List;
import java.util.*;

public class Parser extends Base implements Runnable {
    private Shape field;
    private List<Token> tokens;
    private String decoy = "StringDecoy() should never surface";

    public Token parse(String input) {
        Helper h = new Helper();
        h.run(input);
        return tokenize(input);
    }

    Token tokenize(String s) {
        return inner(s);
    }
}

class Helper {
    void run(String x) { decoyFree(x); }
}

class Base {}
interface Runnable {}
class Shape {}
class Token {}
// CommentDecoy() should never surface
`;

describe("conformance: text/x-java defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-java",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
                // Field type joins to the local class Shape.
                { refName: "Shape", container: "Parser.field" },
            ],
            expectRefs: [
                { name: "List", kind: "import", line: 1 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Runnable", kind: "inherit", line: 4 },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "List", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 9, container: "Parser.parse" },
                { name: "String", kind: "type", line: 9, container: "Parser.parse" },
                { name: "Helper", kind: "type", line: 10, container: "Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 10, container: "Parser.parse" },
                { name: "run", kind: "call", line: 11, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 12, container: "Parser.parse" },
                { name: "inner", kind: "call", line: 16, container: "Parser.tokenize" },
                { name: "decoyFree", kind: "call", line: 21, container: "Helper.run" },
            ],
        });
        // Wildcard import emits nothing — no "util" ref from line 2.
        assert.ok(
            !references.some((r) => r.kind === "import" && r.name !== "List"),
            "only the bound symbol import surfaces; wildcard imports skip",
        );
    });
});
