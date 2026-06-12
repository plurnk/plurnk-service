import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `CC := gcc
OBJS = main.o util.o

all: build test

build: $(OBJS)
\t$(CC) -o app $(OBJS)

main.o: main.c util.h
\t$(CC) -c main.c

test: build
\t./run-tests.sh

# CommentDecoy: fake target
DECOY := "StringDecoy in a string"
.PHONY: all test
`;

describe("conformance: text/x-makefile defs + refs (dev-DSL grind)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-makefile",
            source: SOURCE,
            decoyNames: ["CommentDecoy", "StringDecoy"],
            expectJoins: [
                // The dependency graph make actually executes:
                // all →use→ build / test; test →use→ build.
                { refName: "build", container: "all" },
                { refName: "test", container: "all" },
                { refName: "build", container: "test" },
                // $(CC) in build's recipe joins to the CC variable def.
                { refName: "CC", container: "build" },
            ],
            expectRefs: [
                { name: "build", kind: "use", line: 4, container: "all" },
                { name: "test", kind: "use", line: 4, container: "all" },
                { name: "OBJS", kind: "use", line: 6, container: "build" },
                { name: "CC", kind: "use", line: 7, container: "build" },
                { name: "OBJS", kind: "use", line: 7, container: "build" },
                { name: "main.c", kind: "use", line: 9, container: "main.o" },
                { name: "util.h", kind: "use", line: 9, container: "main.o" },
                { name: "build", kind: "use", line: 12, container: "test" },
                // .PHONY's prerequisites reference real targets.
                { name: "all", kind: "use", line: 17, container: ".PHONY" },
            ],
        });
        // make emits use-kind only.
        assert.ok(references.every((r) => r.kind === "use"));
        // File prerequisites that aren't targets are present (honest rows)
        // but never required to join — main.c has no def.
        assert.ok(references.some((r) => r.name === "main.c"));
        // main.o IS both a prerequisite (via $(OBJS) expansion — not literal)
        // and a target; the literal prereq words main.c/util.h carry the
        // main.o rule as container via line containment.
        assert.equal(references.find((r) => r.name === "util.h")?.container, "main.o");
    });
});
