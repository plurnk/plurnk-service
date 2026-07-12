import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the ocaml.ts mapping emits `module M = struct` defs as containers,
// so refs inside the module carry dotted paths (Shapes.area). Top-level let
// bindings carry the bare def name.
const SOURCE = `open Lexer
include Printable

module Shapes = struct
  type point = { x : int; y : int }

  type shape =
    | Circle of point * float
    | Rect of point * point

  let origin = { x = 0; y = 0 }

  let area (s : shape) : float =
    match s with
    | Circle (_, r) -> r *. r
    | Rect (_, _) -> 0.0
end

let make_circle (p : Shapes.point) (r : float) : Shapes.shape =
  Shapes.Circle (p, r)

let total (shapes : Shapes.shape list) : float =
  List.fold_left (fun acc s -> acc +. Shapes.area s) 0.0 shapes

let label = "StringDecoy should never surface"
(* CommentDecoy should never surface *)
`;

describe("conformance: text/x-ocaml defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-ocaml",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // `Shapes.area s` inside total joins to the local def area —
                // exactly the service's (container, name) edge.
                { refName: "area", container: "total" },
                // Param annotation `(p : Shapes.point)` joins to the record
                // type def point inside module Shapes.
                { refName: "point", container: "make_circle" },
                // Variant payload type `Circle of point * float` joins from
                // inside the shape def to its sibling point def.
                { refName: "point", container: "Shapes.shape" },
            ],
            expectRefs: [
                // Final module_name of the open path.
                { name: "Lexer", kind: "import", line: 1 },
                // `include` is OCaml's closest inheritance analog.
                { name: "Printable", kind: "inherit", line: 2 },
                { name: "int", kind: "type", line: 5, container: "Shapes.point" },
                { name: "point", kind: "type", line: 8, container: "Shapes.shape" },
                { name: "shape", kind: "type", line: 13, container: "Shapes.area" },
                { name: "point", kind: "type", line: 19, container: "make_circle" },
                // Constructor application head (Shapes.Circle (p, r)).
                { name: "Circle", kind: "instantiate", line: 20, container: "make_circle" },
                { name: "shape", kind: "type", line: 22, container: "total" },
                // Member application head (List.fold_left ...).
                { name: "fold_left", kind: "call", line: 23, container: "total" },
                { name: "area", kind: "call", line: 23, container: "total" },
            ],
        });
        // Match-pattern constructor uses (| Circle (_, r) ->) are
        // deconstruction, not instantiation — never emitted.
        assert.ok(
            !references.some((r) => r.name === "Circle" && r.line !== 20),
            "constructor uses in match patterns must not surface",
        );
        // Application arguments and record-literal field names are bare
        // reads — never emitted (use is reserved).
        assert.ok(!references.some((r) => r.name === "shapes" || r.name === "acc" || r.name === "x"));
        // Type DEFINITION names never surface as type refs at their own
        // binding site (line 5 col 8 / line 7 col 8 are the defs).
        assert.ok(!references.some((r) => r.kind === "type" && (r.name === "point" || r.name === "shape") && r.column === 8));
    });
});
