import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiagnosticSource, diagnosticInventory } from "./diagnostic-inventory.mjs";

test("diagnostic inventory extracts constructors, parser errors, and recovery clauses with source coordinates", () => {
    const records = analyzeDiagnosticSource("plurnk-fixture/src/Example.ts", [
        "const one = Results.failure(",
        "    \"scheme:fixture\", \"missing\", 404, \"The resource does not exist.\", {},",
        "    { recovery: \"Choose an existing resource.\", retryable: false },",
        ");",
        "throw new PlurnkParseError(4, 2, \"visitor\", \"expected a target\");",
    ].join("\n"));

    assert.deepEqual(records, [
        {
            kind: "problem-constructor",
            package: "plurnk-fixture",
            file: "plurnk-fixture/src/Example.ts",
            line: 1,
            column: 13,
            callee: "Results.failure",
            arguments: [
                "\"scheme:fixture\"",
                "\"missing\"",
                "404",
                "\"The resource does not exist.\"",
                "{}",
                "{ recovery: \"Choose an existing resource.\", retryable: false }",
            ],
        },
        {
            kind: "recovery",
            package: "plurnk-fixture",
            file: "plurnk-fixture/src/Example.ts",
            line: 3,
            column: 7,
            text: "\"Choose an existing resource.\"",
        },
        {
            kind: "parse-diagnostic",
            package: "plurnk-fixture",
            file: "plurnk-fixture/src/Example.ts",
            line: 5,
            column: 7,
            callee: "PlurnkParseError",
            arguments: ["4", "2", "\"visitor\"", "\"expected a target\""],
        },
    ]);
});

test("diagnostic inventory has deterministic file and source ordering", () => {
    const files = [
        { name: "plurnk-z/src/Z.ts", text: "refuse(\"z\", \"detail\", \"recover\");" },
        { name: "plurnk-a/src/A.ts", text: "Results.problem(\"a\", \"bad\", 400, \"detail\");" },
    ];
    assert.deepEqual(
        diagnosticInventory(files).map(({ file, callee }) => ({ file, callee })),
        [
            { file: "plurnk-a/src/A.ts", callee: "Results.problem" },
            { file: "plurnk-z/src/Z.ts", callee: "refuse" },
        ],
    );
});

test("diagnostic inventory distinguishes private helper calls from declarations and regex text", () => {
    const records = analyzeDiagnosticSource("plurnk-fixture/src/Example.ts", [
        "class Example {",
        "    #failure(code, detail) { return { code, detail }; }",
        "    run() {",
        "        const marker = /#failure/;",
        "        return this.#failure(\"bad\", `Rejected ${marker.source}.`);",
        "    }",
        "}",
    ].join("\n"));

    assert.deepEqual(records.map(({ line, callee }) => ({ line, callee })), [
        { line: 5, callee: "this.#failure" },
    ]);
});
