import { it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

it("conformance: F# signatures project imports and types without implementation-only query nodes ({§mimetype-references})", async () => {
    const { references } = await runConformance({
        mimetype: "text/x-fsharp-signature",
        source: `module Geometry.Core
open System.Collections
open Helpers
type Shape = { Width: int; Height: int }
type Runnable =
    abstract member Run: Shape -> int
val area: shape: Shape -> int
// CommentDecoy should never surface
`,
        decoyNames: ["CommentDecoy"],
        expectJoins: [{ refName: "Shape", container: "Geometry.Core.Runnable.Run" }],
        expectRefs: [
            { name: "System.Collections", kind: "import", line: 2 },
            { name: "Helpers", kind: "import", line: 3 },
            { name: "int", kind: "type", line: 4 },
            { name: "Shape", kind: "type", line: 6, container: "Geometry.Core.Runnable.Run" },
            { name: "int", kind: "type", line: 6 },
            { name: "Shape", kind: "type", line: 7 },
            { name: "int", kind: "type", line: 7 },
        ],
    });
    assert.ok(references.every(({ kind }) => kind !== "call"), "signatures contain no executable call bodies");
});
