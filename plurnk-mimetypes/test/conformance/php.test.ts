import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `<?php
namespace App {
    use Other\\Thing;
    use Lib\\Wide as W;

    class Parser extends Base implements Runnable {
        private Helper $helper;
        private ?Token $token;
        public function parse(string $input): Token {
            $h = new Helper();
            $h->run($input);
            Registry::lookup($input);
            return tokenize($input);
        }
    }
    interface Runnable {}
    trait Mixin {}
    enum Suit: string { case Hearts = 'h'; }
    class Helper {
        public function run(string $x): void { decoyFree($x); }
    }
    function tokenize(string $s): Token { return inner($s); }
}
$decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/x-php defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-php",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside App\\Parser::parse joins to the local
                // class Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "App.Parser.parse" },
                { refName: "tokenize", container: "App.Parser.parse" },
                { refName: "Runnable", container: "App.Parser" },
            ],
            expectRefs: [
                { name: "Thing", kind: "import", line: 3 },
                { name: "Wide", kind: "import", line: 4 },
                { name: "Base", kind: "inherit", line: 6 },
                { name: "Runnable", kind: "inherit", line: 6 },
                { name: "Helper", kind: "type", line: 7, container: "App.Parser.helper" },
                { name: "Token", kind: "type", line: 8, container: "App.Parser.token" },
                { name: "Token", kind: "type", line: 9, container: "App.Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 10, container: "App.Parser.parse" },
                { name: "run", kind: "call", line: 11, container: "App.Parser.parse" },
                { name: "lookup", kind: "call", line: 12, container: "App.Parser.parse" },
                { name: "tokenize", kind: "call", line: 13, container: "App.Parser.parse" },
                { name: "inner", kind: "call", line: 22, container: "App.tokenize" },
            ],
        });
        // Aliased use captures the original name, never the alias.
        assert.ok(!references.some((r) => r.name === "W"));
        // primitive_type (string) is excluded from type refs; nullable
        // ?Token surfaces exactly once.
        assert.ok(!references.some((r) => r.name === "string"));
        assert.equal(references.filter((r) => r.name === "Token" && r.line === 8).length, 1);
    });
});
