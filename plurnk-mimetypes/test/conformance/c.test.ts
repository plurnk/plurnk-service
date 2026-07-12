import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the c.ts mapping is FLAT except enum bodies (enumerators carry the
// enum name as container), so ref containers are the bare names of the
// enclosing function/struct/typedef defs by line containment.
const SOURCE = `#include <stdio.h>
#include "local.h"

struct Shape { int w; };
enum Color { RED, GREEN };
typedef struct Shape ShapeT;
typedef int Token;

struct Holder {
    ShapeT inner;
    struct Shape raw;
};

Token tokenize(const char *s, struct Shape sh) {
    printf("StringDecoy() %s", s);
    return 0;
}

ShapeT *make_shape(Token t, enum Color c) {
    struct Shape local;
    ShapeT *p = (ShapeT *)0;
    Token tk = tokenize("x", local);
    helper(tk);
    return p;
}

void helper(Token t) {}
// CommentDecoy() never surfaces
`;

describe("conformance: text/x-c defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-c",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize("x", local) inside make_shape joins to the local
                // function def — exactly the service's (container, name) edge.
                { refName: "tokenize", container: "make_shape" },
                { refName: "helper", container: "make_shape" },
                { refName: "Shape", container: "Holder" },
            ],
            expectRefs: [
                // typedef underlying tag use; the typedef def spans its own
                // line, so it is the innermost container for the ref.
                { name: "Shape", kind: "type", line: 6, container: "ShapeT" },
                { name: "ShapeT", kind: "type", line: 10, container: "Holder" },
                { name: "Shape", kind: "type", line: 11, container: "Holder" },
                // Return type and tagged param of tokenize.
                { name: "Token", kind: "type", line: 14, container: "tokenize" },
                { name: "Shape", kind: "type", line: 14, container: "tokenize" },
                { name: "printf", kind: "call", line: 15, container: "tokenize" },
                { name: "ShapeT", kind: "type", line: 19, container: "make_shape" },
                { name: "Color", kind: "type", line: 19, container: "make_shape" },
                { name: "Shape", kind: "type", line: 20, container: "make_shape" },
                // Declaration type AND cast type_descriptor on one line.
                { name: "ShapeT", kind: "type", line: 21, column: 5 },
                { name: "ShapeT", kind: "type", line: 21, column: 18 },
                { name: "tokenize", kind: "call", line: 22, container: "make_shape" },
                { name: "helper", kind: "call", line: 23, container: "make_shape" },
                { name: "Token", kind: "type", line: 27, container: "helper" },
            ],
        });
        // #include takes path strings, not symbol names — no import refs
        // for C (SPEC §16 bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for C");
        assert.ok(!references.some((r) => r.name === "stdio.h" || r.name === "local.h"));
    });
});
