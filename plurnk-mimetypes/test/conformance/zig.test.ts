import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the zig.ts mapping is FLAT for functions (methods inside struct
// declarations are not emitted), but struct container_fields carry the
// struct name as container — so refs on a field's own line resolve to the
// field's qualified path (e.g. "Token.shape"), refs elsewhere inside the
// struct body resolve to the struct, and refs in functions resolve to the
// bare function names.
const SOURCE = `const std = @import("std");

const Token = struct {
    kind: u8,
    shape: Shape,

    pub fn weight(self: Token) u32 {
        return self.shape.w;
    }
};

const Shape = struct { w: u32 };

pub fn tokenize(input: []const u8, sh: Shape) Token {
    std.debug.print("StringDecoy() {s}\\n", .{input});
    const n: u32 = @intCast(input.len);
    _ = n;
    return Token{ .kind = 1, .shape = sh };
}

pub fn helper(t: *Token, u: ?Token) !Shape {
    const s: Shape = Shape{ .w = 2 };
    _ = t.weight();
    _ = u;
    return s;
}

pub fn main() void {
    const sh = Shape{ .w = 1 };
    const tok = tokenize("x", sh);
    _ = helper(&tok, null);
}
// CommentDecoy() never surfaces
`;

describe("conformance: text/x-zig defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-zig",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize("x", sh) inside main joins to the local function
                // def — exactly the service's (container, name) edge.
                { refName: "tokenize", container: "main" },
                { refName: "helper", container: "main" },
                // Field type ref on the field's own line: the container_field
                // def is the innermost span, so the qualified path is the key.
                { refName: "Shape", container: "Token.shape" },
                { refName: "Shape", container: "helper" },
            ],
            expectRefs: [
                { name: "Shape", kind: "type", line: 5, container: "Token.shape" },
                // weight's param — the method is not a def, so the struct is
                // the innermost enclosing emitted def.
                { name: "Token", kind: "type", line: 7, container: "Token" },
                // Param and return types of tokenize.
                { name: "Shape", kind: "type", line: 14, container: "tokenize" },
                { name: "Token", kind: "type", line: 14, container: "tokenize" },
                // Member-call final (std.debug.print → print).
                { name: "print", kind: "call", line: 15, container: "tokenize" },
                { name: "Token", kind: "instantiate", line: 18, container: "tokenize" },
                // Pointer (*Token), nullable (?Token), error-union (!Shape).
                { name: "Token", kind: "type", line: 21, column: 19 },
                { name: "Token", kind: "type", line: 21, column: 30 },
                { name: "Shape", kind: "type", line: 21, column: 38 },
                // Explicitly typed const AND struct init on one line.
                { name: "Shape", kind: "type", line: 22, container: "helper" },
                { name: "Shape", kind: "instantiate", line: 22, container: "helper" },
                { name: "weight", kind: "call", line: 23, container: "helper" },
                { name: "Shape", kind: "instantiate", line: 29, container: "main" },
                { name: "tokenize", kind: "call", line: 30, container: "main" },
                { name: "helper", kind: "call", line: 31, container: "main" },
            ],
        });
        // @import takes path strings, not symbol names — no import refs for
        // Zig (SPEC §16 bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Zig");
        assert.ok(!references.some((r) => r.name === "std"), "import path binding never surfaces");
        // Builtins are builtin_function nodes, not call_expressions —
        // compiler intrinsics never enter the refs stream.
        assert.ok(!references.some((r) => r.name.startsWith("@") || r.name === "intCast"));
    });
});
