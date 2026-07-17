import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `import { Helper, type Shape } from "./helper";
import Default, { Other as O } from "./default";

export class Parser extends Base implements Runnable {
    field: Shape;
    parse(input: string): Token {
        const h = new Helper();
        h.run(input);
        return tokenize(input);
    }
}
class Helper {
    run(x: string): void { decoyFree(x); }
}
function tokenize(s: string): Token { return inner(s); }
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/typescript defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/typescript",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "Helper", kind: "import", line: 1 },
                { name: "Shape", kind: "import", line: 1 },
                { name: "Default", kind: "import", line: 2 },
                { name: "Other", kind: "import", line: 2 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Runnable", kind: "inherit", line: 4 },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "Token", kind: "type", line: 6 },
                { name: "Helper", kind: "instantiate", line: 7, container: "Parser.parse" },
                { name: "run", kind: "call", line: 8, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 9, container: "Parser.parse" },
                { name: "inner", kind: "call", line: 15, container: "tokenize" },
            ],
        });
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 5);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
