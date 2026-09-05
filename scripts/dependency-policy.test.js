import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { TREE_SITTER_REGISTRY } from "../plurnk-mimetypes/src/treesitter/registry.ts";
import {
    defaultGrammarViolations,
    installScriptViolations,
    workspaceNpmConfigViolations,
} from "./dependency-policy.mjs";

describe("default grammar composition ({§default-plugin-ownership})", () => {
    const dependencies = Object.fromEntries(TREE_SITTER_REGISTRY.map(({ slug }) =>
        [`@plurnk/plurnk-mimetypes-grammar-${slug}`, "1.0.0"]));

    it("requires every registered grammar as a service runtime dependency", async () => {
        const manifest = JSON.parse(await readFile(new URL("../plurnk-core/package.json", import.meta.url), "utf8"));
        assert.deepEqual(defaultGrammarViolations(manifest), []);
    });

    it("accepts the complete registry including mimetype aliases sharing a leaf", () => {
        assert.deepEqual(defaultGrammarViolations({ dependencies }), []);
    });

    for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
        it(`does not let ${section} substitute for required installation`, () => {
            const { "@plurnk/plurnk-mimetypes-grammar-cpp": cpp, ...rest } = dependencies;
            assert.deepEqual(defaultGrammarViolations({
                dependencies: rest,
                [section]: { "@plurnk/plurnk-mimetypes-grammar-cpp": cpp },
            }), ["plurnk-core/package.json: dependencies.@plurnk/plurnk-mimetypes-grammar-cpp is required by {§default-plugin-ownership}"]);
        });
    }
});

describe("dependency policy install-script review", () => {
    it("accepts a tree with no unreviewed install scripts", () => {
        assert.deepEqual(installScriptViolations({ allowScripts: [] }), []);
    });

    it("names every package whose install script remains unreviewed", () => {
        assert.deepEqual(installScriptViolations({
            allowScripts: [{
                name: "esbuild",
                changes: [{ key: "esbuild@0.28.2", change: "pending" }],
            }],
        }), ["package.json: allowScripts does not review esbuild@0.28.2"]);
    });

    it("rejects an invalid npm report instead of treating it as green", () => {
        assert.throws(() => installScriptViolations({}), {
            name: "TypeError",
            message: "npm install-scripts returned an invalid allowScripts report",
        });
    });
});

describe("dependency policy configuration ownership", () => {
    it("rejects workspace-local npm configuration with an actionable owner", () => {
        assert.deepEqual(workspaceNpmConfigViolations(["plurnk-core/.npmrc"]), [
            "plurnk-core/.npmrc: npm ignores workspace-local configuration; declare repository policy in the root .npmrc",
        ]);
    });
});
