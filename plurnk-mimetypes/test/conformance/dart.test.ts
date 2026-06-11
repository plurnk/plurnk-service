import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// tree-sitter-dart parses bodies as siblings of their signatures; the
// extractor extends each def's span over the sibling function_body
// (issue #22), so refs inside multi-line bodies join at method level.
const SOURCE = `import 'package:demo/helper.dart' show Helper, Shape hide Junk;
import 'dart:math';

class Parser extends Base with Mixy implements Runnable {
  Shape field;
  final List<Token> tokens = [];
  Token parse(String input) {
    return tokenize(input);
  }
  void build() {
    final h = new Helper();
    final p = const Point(1, 2);
    h.run(field);
  }
}
class Helper {
  void run(Shape x) {
    decoyFree(x);
  }
}
mixin Mixy on Base {}
enum Color { red, green }
Token tokenize(String s) {
  return inner(s);
}
void main() {
  Shape s = make();
  s?.draw();
}
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/x-dart defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-dart",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize(input) inside Parser.parse's multi-line body joins
                // to the local function tokenize — exactly the service's
                // (container, name) edge.
                { refName: "tokenize", container: "Parser.parse" },
                { refName: "Helper", container: "Parser.build" },
                { refName: "Mixy", container: "Parser" },
            ],
            expectRefs: [
                { name: "Helper", kind: "import", line: 1 },
                { name: "Shape", kind: "import", line: 1 },
                { name: "Base", kind: "inherit", line: 4, container: "Parser" },
                { name: "Mixy", kind: "inherit", line: 4, container: "Parser" },
                { name: "Runnable", kind: "inherit", line: 4, container: "Parser" },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "List", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 7, container: "Parser.parse" },
                { name: "String", kind: "type", line: 7, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 8, container: "Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 11, container: "Parser.build" },
                { name: "Point", kind: "instantiate", line: 12, container: "Parser.build" },
                { name: "run", kind: "call", line: 13, container: "Parser.build" },
                { name: "decoyFree", kind: "call", line: 18, container: "Helper.run" },
                { name: "Base", kind: "inherit", line: 21, container: "Mixy" },
                { name: "inner", kind: "call", line: 24, container: "tokenize" },
                { name: "Shape", kind: "type", line: 27, container: "main" },
                { name: "make", kind: "call", line: 27, container: "main" },
                { name: "draw", kind: "call", line: 28, container: "main" },
            ],
        });
        // hide combinator names are explicitly unbound — never imports.
        assert.ok(!references.some((r) => r.name === "Junk"), "hide name must not surface");
        // Bare reads stay out: argument identifiers are not refs.
        assert.ok(
            !references.some((r) => r.name === "field" && r.line === 13),
            "argument identifier surfaced as a ref",
        );
    });
});
