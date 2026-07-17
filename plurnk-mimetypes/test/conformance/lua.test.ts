import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the lua.ts mapping is FLAT (top-level walk only — function/method
// defs carry no containers), so ref containers are the bare names of the
// enclosing function defs (helper/process/run).
const SOURCE = `local M = {}

local function helper(x)
  return x + 1
end

function M.process(input)
  local v = helper(input)
  M.finish(v)
  return v
end

function M:run(input)
  local r = M.process(helper(input))
  self:emit(r)
  obj.mod.deep(r)
  print(r)
  local lib = require("some.lib")
  return lib
end

setmetatable(M, { __index = Base })
local s = "StringDecoy() should never surface"
-- CommentDecoy() should never surface
`;

describe("conformance: text/x-lua defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-lua",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // helper(input) inside M.process joins to the local function
                // helper — exactly the service's (container, name) edge.
                { refName: "helper", container: "process" },
                { refName: "process", container: "run" },
                { refName: "helper", container: "run" },
            ],
            expectRefs: [
                { name: "helper", kind: "call", line: 8, container: "process" },
                // Dotted call: M.finish(v) → field name.
                { name: "finish", kind: "call", line: 9, container: "process" },
                // Dotted call to a sibling def: M.process(...) → process.
                { name: "process", kind: "call", line: 14, container: "run" },
                { name: "helper", kind: "call", line: 14, container: "run" },
                // Method call: self:emit(r) → method name.
                { name: "emit", kind: "call", line: 15, container: "run" },
                // Chained dotted call: obj.mod.deep(r) → final field.
                { name: "deep", kind: "call", line: 16, container: "run" },
                { name: "print", kind: "call", line: 17, container: "run" },
                // Top-level call has no container.
                { name: "setmetatable", kind: "call", line: 22 },
            ],
        });
        // v1 decisions: require() takes a path string — no import refs;
        // metatable inheritance is dynamic — no inherit refs; Lua has no
        // types or constructors — no type/instantiate refs.
        assert.ok(references.every((r) => r.kind === "call"), "lua emits only call refs");
        assert.ok(!references.some((r) => r.name === "require"), "require is the import mechanism, not a call ref");
        assert.ok(!references.some((r) => r.name === "Base"), "metatable __index value is not an inherit ref");
    });
});
