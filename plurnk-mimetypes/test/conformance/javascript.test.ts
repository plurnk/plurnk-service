import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `import { Helper, Other as O } from "./helper";
import Default from "./default";

export class Parser extends Base {
    parse(input) {
        const h = new Helper();
        h.run(input);
        return tokenize(input);
    }
}
class Helper {
    run(x) { decoyFree(x); }
}
function tokenize(s) { return inner(s); }
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/javascript defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/javascript",
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
                { name: "Other", kind: "import", line: 1 },
                { name: "Default", kind: "import", line: 2 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Helper", kind: "instantiate", line: 6, container: "Parser.parse" },
                { name: "run", kind: "call", line: 7, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 8, container: "Parser.parse" },
                { name: "decoyFree", kind: "call", line: 12, container: "Helper.run" },
                { name: "inner", kind: "call", line: 14, container: "tokenize" },
            ],
        });
        // Aliased import captures the original exported name, not the alias.
        assert.ok(!references.some((r) => r.name === "O"));
        // Module-path strings never surface as refs.
        assert.ok(!references.some((r) => r.name.includes("./")));
    });
});
