import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `use std::collections::HashMap;
use crate::helper::{Widget, Shape as S};
use std::mem;

struct Helper {
    count: u32,
}

impl Helper {
    fn create() -> Helper {
        Helper { count: 0 }
    }
    fn process(&self, input: &str) -> Token {
        tokenize(input)
    }
}

trait Runnable {
    fn run(&self);
}

struct Engine {
    field: Shape,
    map: HashMap<String, Token>,
}

impl Runnable for Engine {
    fn run(&self) {
        let h: Helper = Helper::create();
        h.process("x");
        mem::drop(h);
    }
}

fn tokenize(s: &str) -> Token {
    inner(s)
}

const DECOY: &str = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("conformance: text/x-rust defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-rust",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // let h: Helper inside Engine.run joins to the local struct
                // Helper — the service's (container, name) edge. The rust
                // mapping emits impl-typed containers, so methods carry the
                // impl'd type's name.
                { refName: "Helper", container: "Engine.run" },
                { refName: "create", container: "Engine.run" },
                { refName: "tokenize", container: "Helper.process" },
            ],
            expectRefs: [
                { name: "HashMap", kind: "import", line: 1 },
                { name: "Widget", kind: "import", line: 2 },
                // Aliased `Shape as S` captures the ORIGINAL name.
                { name: "Shape", kind: "import", line: 2 },
                { name: "mem", kind: "import", line: 3 },
                { name: "Helper", kind: "type", line: 10, container: "Helper.create" },
                { name: "Helper", kind: "instantiate", line: 11, container: "Helper.create" },
                { name: "Token", kind: "type", line: 13, container: "Helper.process" },
                { name: "tokenize", kind: "call", line: 14, container: "Helper.process" },
                { name: "Shape", kind: "type", line: 23, container: "Engine" },
                { name: "HashMap", kind: "type", line: 24, container: "Engine" },
                { name: "Runnable", kind: "inherit", line: 27 },
                { name: "Helper", kind: "type", line: 29, container: "Engine.run" },
                { name: "create", kind: "call", line: 29, container: "Engine.run" },
                { name: "process", kind: "call", line: 30, container: "Engine.run" },
                { name: "drop", kind: "call", line: 31, container: "Engine.run" },
                { name: "Token", kind: "type", line: 35, container: "tokenize" },
                { name: "inner", kind: "call", line: 36, container: "tokenize" },
            ],
        });
        // The alias itself (`S`) never surfaces — only the original name.
        assert.ok(!references.some((r) => r.name === "S"));
        // No bare identifier reads: `input`, `h`, `s` argument reads stay out.
        for (const bare of ["input", "h", "s"]) {
            assert.ok(
                !references.some((r) => r.name === bare),
                `bare identifier read "${bare}" surfaced as a ref`,
            );
        }
    });
});
