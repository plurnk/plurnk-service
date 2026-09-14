// {§parser-consumers} — the parser is the one home of the language implementation, and the
// contracts package a client installs carries none of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Contracts from "@plurnk/plurnk-contracts";
import * as Parser from "../../src/index.ts";

test("{§parser-consumers}: the parser package exports exactly the parser surface", () => {
    assert.deepEqual(Object.keys(Parser).sort(), ["PlurnkParser", "parsePath"]);
});

test("{§parser-consumers}: contracts exports no parser and depends on no parser runtime", () => {
    assert.equal("PlurnkParser" in Contracts, false, "PlurnkParser is not a contracts export");
    assert.equal("parsePath" in Contracts, false, "parsePath is not a contracts export");
    const manifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/package.json")), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    for (const runtime of ["antlr4ng", "xpath", "json-p3"]) {
        assert.equal(Object.hasOwn(manifest.dependencies ?? {}, runtime), false, `${runtime} is not a contracts dependency`);
    }
    assert.equal(Object.hasOwn(manifest.devDependencies ?? {}, "antlr-ng"), false, "the grammar compiler left contracts too");
});
