import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discover } from "../discover.ts";
import Mimetypes from "../Mimetypes.ts";

describe("tree-sitter registry — dispatch wiring", () => {
    it("discover() seeds tree-sitter entries by default", async () => {
        const result = await discover({ packageDirs: [] });
        const py = result.handlers.get("text/x-python");
        assert.ok(py);
        assert.equal(py.source, "treesitter");
        assert.equal(py.packageName, "tree-sitter-python");
        assert.equal(py.glyph, "🐍");
    });

    it("discover() includeTreeSitter:false skips the seed (test-only)", async () => {
        const result = await discover({ packageDirs: [], includeTreeSitter: false });
        assert.equal(result.handlers.get("text/x-python"), undefined);
    });

    it("detect() routes .py to text/x-python via the registry baseline", async () => {
        const mt = new Mimetypes();
        const resolved = await mt.detect({ path: "src/foo.py" });
        assert.equal(resolved, "text/x-python");
    });

    it("getHandler() returns a working TreeSitterLanguageHandler for text/x-python", async () => {
        const mt = new Mimetypes();
        const handler = await mt.getHandler("text/x-python");
        assert.ok(handler);
        const syms = await handler.extractRaw("def add(a, b):\n    return a + b\n");
        const add = syms.find((s) => s.name === "add");
        assert.ok(add);
        assert.equal(add.kind, "function");
        assert.deepEqual(add.params, ["a", "b"]);
    });

    it("process() pipeline runs end-to-end against a tree-sitter handler", async () => {
        const mt = new Mimetypes();
        const result = await mt.process({
            hint: "text/x-python",
            content: "class Foo:\n    def bar(self):\n        return 42\n",
        });
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/x-python");
        const names = (result.symbols ?? []).map((s) => `${s.kind} ${s.name}`);
        assert.ok(names.includes("class Foo"), `expected class Foo in ${names}`);
        assert.ok(names.includes("method bar"), `expected method bar in ${names}`);
    });
});
