import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE on containers: the fsharp mapping emits named modules, record/union
// types + their fields/cases, top-level let bindings, AND implicit-constructor
// types (anon_type_defn, `type Parser(...) =`) with their members (issue #22).
// Refs inside member bodies resolve to the member's dotted path
// (Geometry.Core.Parser.Parse); refs in the type header (inherit/interface)
// resolve to the type itself (probed via extractRaw).
const SOURCE = `module Geometry.Core

open System.Collections
open Helpers

type Shape = { Width: int; Height: int }

type Color = Red | Green

type Runnable =
    abstract member Run: Shape -> int

type Parser(token: string) =
    inherit BaseParser()
    interface Runnable with
        member this.Run () = ignore token
    member this.Parse (input: string) : Shape =
        let h = Helper()
        let b = new BaseParser()
        h.Run input
        tokenize input

let tokenize (s: string) : Shape =
    inner s

let area (shape: Shape) : int =
    shape.Width * shape.Height

let decoy = "StringDecoy should never surface"
// CommentDecoy should never surface
`;

describe("conformance: text/x-fsharp defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-fsharp",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize's return annotation names the local record Shape;
                // the ref sits inside the emitted def `tokenize`.
                { refName: "Shape", container: "Geometry.Core.tokenize" },
                { refName: "Shape", container: "Geometry.Core.area" },
                // Call inside Parser.Parse — anon_type_defn members are
                // emitted (issue #22), so the ref joins at member level.
                { refName: "tokenize", container: "Geometry.Core.Parser.Parse" },
                // Interface clause names the local Runnable type; the ref
                // sits in Parser's header, inside the emitted Parser def.
                { refName: "Runnable", container: "Geometry.Core.Parser" },
            ],
            expectRefs: [
                // open captures the full dotted name — the mapping's
                // joinable module-def form.
                { name: "System.Collections", kind: "import", line: 3 },
                { name: "Helpers", kind: "import", line: 4 },
                { name: "int", kind: "type", line: 6 },
                // Member-signature annotation types — the abstract member is
                // itself an emitted def (anon_type_defn, issue #22).
                { name: "Shape", kind: "type", line: 11, container: "Geometry.Core.Runnable.Run" },
                { name: "int", kind: "type", line: 11, container: "Geometry.Core.Runnable.Run" },
                { name: "BaseParser", kind: "inherit", line: 14, container: "Geometry.Core.Parser" },
                { name: "Runnable", kind: "inherit", line: 15, container: "Geometry.Core.Parser" },
                // Construction is syntactically application → call
                // (python precedent), with or without `new`.
                { name: "Helper", kind: "call", line: 18, container: "Geometry.Core.Parser.Parse" },
                { name: "BaseParser", kind: "call", line: 19, container: "Geometry.Core.Parser.Parse" },
                // Dotted application head → final name.
                { name: "Run", kind: "call", line: 20, container: "Geometry.Core.Parser.Parse" },
                { name: "tokenize", kind: "call", line: 21, container: "Geometry.Core.Parser.Parse" },
                { name: "inner", kind: "call", line: 24 },
                { name: "Shape", kind: "type", line: 26, container: "Geometry.Core.area" },
            ],
        });
        // Application arguments are the same node shape as heads — only the
        // anchored head surfaces (`tokenize input` must not emit `input`).
        assert.ok(!references.some((r) => r.name === "input"), "argument read leaked as ref");
        // Bare dotted reads (`shape.Width`) are not applications — no ref.
        assert.ok(
            !references.some((r) => r.name === "Width" && r.kind === "call"),
            "bare member read leaked as call",
        );
    });
});
