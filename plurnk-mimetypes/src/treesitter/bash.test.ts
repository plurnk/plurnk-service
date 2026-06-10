import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-shellscript")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-shellscript via tree-sitter registry", () => {
    it("extracts function definitions (both 'function f' and 'f()' forms)", async () => {
        const src = "function greet() {\n  echo hi\n}\n\nfarewell() {\n  echo bye\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "greet")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "farewell")?.kind, "function");
    });

    it("variable assignment → variable", async () => {
        const syms = await h().extractRaw("DB_HOST=localhost\n");
        assert.equal(syms.find((s) => s.name === "DB_HOST")?.kind, "variable");
    });

    it("readonly → constant", async () => {
        const syms = await h().extractRaw("readonly DB_PORT=5432\n");
        assert.equal(syms.find((s) => s.name === "DB_PORT")?.kind, "constant");
    });

    it("declare/export wraps still extracts the variable", async () => {
        const syms = await h().extractRaw("declare -x APP_ENV=prod\nexport AWS_REGION=us-east-1\n");
        assert.ok(syms.find((s) => s.name === "APP_ENV"));
        assert.ok(syms.find((s) => s.name === "AWS_REGION"));
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("function (((broken"));
    });
});

describe("text/x-shellscript — container + columns (issue #18)", () => {
    it("all symbols carry 1-indexed columns; functions are flat (no container)", async () => {
        const src = "greet() {\n  echo hi\n}\nDB_HOST=localhost\n";
        const syms = await h().extractRaw(src);
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.container, undefined);
        assert.equal(greet?.column, 1);
        assert.ok((greet?.endColumn ?? 0) >= 1);
        const db = syms.find((s) => s.name === "DB_HOST");
        assert.equal(db?.container, undefined);
        assert.equal(db?.column, 1);
    });
});
