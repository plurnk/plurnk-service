import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectDirections } from "./audit/direction.mjs";

const fixture = async (t, sources) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-direction-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspaces = [...new Set(Object.keys(sources).map((name) => name.split("/")[0]))];
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces, type: "module" }));
    for (const [file, source] of Object.entries(sources)) {
        const input = join(root, file);
        const output = input.replace("/src/", "/dist/").replace(/\.ts$/u, ".js");
        await mkdir(dirname(input), { recursive: true });
        await mkdir(dirname(output), { recursive: true });
        await writeFile(input, source);
        await writeFile(output, stripTypeScriptTypes(source));
    }
    return root;
};

test("runtime direction audit excludes erased imports and re-exports without interpreting TypeScript", async (t) => {
    const root = await fixture(t, {
        "plurnk-core/src/a.ts": 'import type { B } from "./b.js"; export type { B } from "./b.js"; export type A = B; export const a = 1;',
        "plurnk-core/src/b.ts": 'import { a } from "./a.js"; export type B = number; export const b = a;',
    });
    await writeFile(join(root, "plurnk-core/dist/a.d.ts"), 'export type A = import("./types.ts").A;');
    const report = await inspectDirections(root);
    assert.deepEqual(report.violations, []);
    assert.equal(report.modules.length, 2);
    assert.deepEqual(report.modules.find(({ source }) => source.endsWith("/a.js")).dependencies, []);
    assert.equal(report.modules.find(({ source }) => source.endsWith("/b.js")).dependencies.length, 1);
});

test("runtime direction audit retains a side-effect edge beside a type-only import", async (t) => {
    const root = await fixture(t, {
        "plurnk-core/src/a.ts": 'import type { B } from "./b.js"; import "./b.js"; export type A = B; export const a = 1;',
        "plurnk-core/src/b.ts": 'import { a } from "./a.js"; export type B = number; export const b = a;',
    });
    const { violations } = await inspectDirections(root);
    assert.ok(violations.some(({ rule }) => rule.name === "no-circular"));
});

test("runtime direction audit enforces owner boundaries on emitted imports", async (t) => {
    const root = await fixture(t, {
        "plurnk-core/src/index.ts": "export const value = 1;",
        "plurnk-parser/src/index.ts": "export const parse = 1;",
        "plurnk-mimetypes/src/index.ts": 'export { value } from "../../plurnk-mimetypes-text-plain/dist/index.js";',
        "plurnk-mimetypes-text-plain/src/index.ts": 'export { value } from "../../plurnk-core/dist/index.js";',
        "plurnk-schedule/src/index.ts": 'export { parse } from "../../plurnk-parser/dist/index.js";',
    });
    const names = (await inspectDirections(root)).violations.map(({ rule }) => rule.name);
    assert.ok(names.includes("no-leaf-to-core"));
    assert.ok(names.includes("no-framework-to-own-leaf"));
    assert.ok(names.includes("parser-only-where-declared"));
});

test("runtime direction audit reports unresolved imports and refuses missing build output", async (t) => {
    const root = await fixture(t, { "plurnk-core/src/a.ts": 'import "./absent.js";' });
    assert.ok((await inspectDirections(root)).violations.some(({ rule }) => rule.name === "no-unresolved"));
    await rm(join(root, "plurnk-core/dist"), { recursive: true });
    await assert.rejects(inspectDirections(root), /plurnk-core.*no built JavaScript/);
});
