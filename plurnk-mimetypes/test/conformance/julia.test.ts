import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `module Geometry

using LinearAlgebra
using Printf: @printf, format
import Statistics as Stats

abstract type AbstractShape end

struct Circle <: AbstractShape
    radius::Float64
    points::Vector{Point}
end

function area(c::Circle)::Float64
    return 3.14159 * c.radius * c.radius
end

function summarize(shapes)
    c = Circle(1.0, [])
    total = area(c)
    scaled = area.(shapes)
    m = Stats.mean(scaled)
    @printf("%.2f", total)
    return total + m
end

scale(c::Circle, k) = Circle(c.radius * k, c.points)

DECOY = "StringDecoy() should never surface"
# CommentDecoy() should never surface

end
`;

describe("conformance: text/x-julia defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-julia",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // struct Circle <: AbstractShape joins to the local abstract
                // type — the inherit edge inside the Circle def's span.
                { refName: "AbstractShape", container: "Geometry.Circle" },
                // Circle(1.0, []) inside summarize joins to the local struct
                // (constructors are syntactically calls in Julia).
                { refName: "Circle", container: "Geometry.summarize" },
                { refName: "area", container: "Geometry.summarize" },
            ],
            expectRefs: [
                { name: "LinearAlgebra", kind: "import", line: 3 },
                // Selected imports: module AND bindings; @printf joins defs
                // channel convention (macro names without @).
                { name: "Printf", kind: "import", line: 4 },
                { name: "printf", kind: "import", line: 4 },
                { name: "format", kind: "import", line: 4 },
                // `as` rebind: the ORIGINAL name, never the alias.
                { name: "Statistics", kind: "import", line: 5 },
                { name: "AbstractShape", kind: "inherit", line: 9, container: "Geometry.Circle" },
                { name: "Float64", kind: "type", line: 10, container: "Geometry.Circle" },
                // Parametric field type: head and parameter.
                { name: "Vector", kind: "type", line: 11, container: "Geometry.Circle" },
                { name: "Point", kind: "type", line: 11, container: "Geometry.Circle" },
                // Signature annotations: param type and return type.
                { name: "Circle", kind: "type", line: 14, container: "Geometry.area" },
                { name: "Float64", kind: "type", line: 14, container: "Geometry.area" },
                { name: "Circle", kind: "call", line: 19, container: "Geometry.summarize" },
                { name: "area", kind: "call", line: 20, container: "Geometry.summarize" },
                // Broadcast call: area.(shapes).
                { name: "area", kind: "call", line: 21, container: "Geometry.summarize" },
                // Qualified call: Stats.mean → mean.
                { name: "mean", kind: "call", line: 22, container: "Geometry.summarize" },
                // Macro invocation: @printf → printf.
                { name: "printf", kind: "call", line: 23, container: "Geometry.summarize" },
                // Short-form def line: LHS param type + RHS constructor call.
                { name: "Circle", kind: "type", line: 27, container: "Geometry.scale" },
                { name: "Circle", kind: "call", line: 27, container: "Geometry.scale" },
            ],
        });
        // `import Statistics as Stats` — the alias must not surface.
        assert.ok(!references.some((r) => r.name === "Stats"), "alias 'Stats' must not surface");
        // Def-shaped heads are not uses: `function area(c)` (signature call)
        // and `scale(c, k) = ...` (assignment-LHS call) emit no call refs.
        assert.ok(
            !references.some((r) => r.name === "area" && r.kind === "call" && r.line === 14),
            "function signature callee must not surface as a call",
        );
        assert.ok(
            !references.some((r) => r.name === "scale"),
            "short-form definition head must not surface",
        );
    });
});
