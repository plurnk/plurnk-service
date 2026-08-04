import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExactModuleAbsent } from "./module-absence.ts";
import { resolveWasmPath } from "./treesitter/handler.ts";

describe("exact module absence", () => {
    it("recognizes the exact requested grammar manifest", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error(`Cannot find module '${specifier}'`),
            { code: "MODULE_NOT_FOUND" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), true);
    });

    it("does not classify an exports defect as package absence", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error(`Package subpath './package.json' is not defined by exports in ${specifier}`),
            { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), false);
    });

    it("does not classify a missing transitive dependency as artifact absence", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error("Cannot find module 'broken-transitive-dependency'"),
            { code: "MODULE_NOT_FOUND" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), false);
    });

    it("maps an exactly absent grammar leaf to GrammarNotInstalledError", async () => {
        await assert.rejects(
            resolveWasmPath({
                mimetype: "text/x-definitely-absent",
                glyph: "",
                extensions: [],
                slug: "definitely-absent",
                revision: "test-1",
                importMapping: async () => ({ extract: () => [] }),
            }),
            (error: unknown) => {
                assert.equal((error as Error).name, "GrammarNotInstalledError");
                assert.equal(
                    (error as { plurnkPackage?: unknown }).plurnkPackage,
                    "@plurnk/plurnk-mimetypes-grammar-definitely-absent",
                );
                return true;
            },
        );
    });
});
