import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the root pins the ordinary Node and npm toolchain", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    assert.equal(manifest.engines.node, ">=26");
    assert.equal(manifest.packageManager, "npm@12.2.0");
    assert.equal(manifest.scripts.prepare, "git config core.hooksPath .githooks && npm run build");
    assert.equal(manifest.scripts["config:list"], "node --conditions=plurnk-dev plurnk-core/src/service.ts config defaults");
    assert.equal(await readFile(new URL(".node-version", root), "utf8"), "26\n");
});

test("{§native-source-toolchain}: source checking has one modern ECMAScript module contract", async () => {
    const { compilerOptions } = JSON.parse(await readFile(new URL("tsconfig.base.json", root), "utf8"));
    assert.equal(compilerOptions.target, "ESNext");
    assert.deepEqual(compilerOptions.lib, ["ESNext"]);
    assert.equal(compilerOptions.module, "NodeNext");
    assert.equal(compilerOptions.moduleResolution, "NodeNext");
    assert.equal(compilerOptions.erasableSyntaxOnly, true);
    assert.equal(compilerOptions.verbatimModuleSyntax, true);
    const { workspaces } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    for (const workspace of workspaces.filter((name) => name !== "plurnk-spec-check")) {
        const config = JSON.parse(await readFile(new URL(`${workspace}/tsconfig.json`, root), "utf8"));
        assert.equal(config.extends, "../tsconfig.base.json", workspace);
        for (const option of ["target", "lib", "module", "moduleResolution", "erasableSyntaxOnly", "verbatimModuleSyntax"]) {
            assert.equal(Object.hasOwn(config.compilerOptions ?? {}, option), false,
                `${workspace} inherits ${option}; browser-specific checking belongs in its own config`);
        }
    }
});
