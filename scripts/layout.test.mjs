import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// {§scripts-layout} — what a person runs sits at the top of scripts/ and under audit/; what those
// import sits under lib/. "Named" means a package.json script or a git hook spells the path.
const root = join(import.meta.dirname, "..");
const CODE = /\.(?:mjs|js|ts|mts|sh)$/u;
const isCode = (name) => CODE.test(name) && !/\.test\.[^.]+$/u.test(name) && !name.endsWith(".d.mts");

// One entry per package: its base directory ("" for the root) and the text that may name a script
// (its package.json scripts; for the root, the git hooks too).
const packages = async () => {
    const read = async (base) => JSON.parse(await readFile(join(root, base, "package.json"), "utf8"));
    const rootManifest = await read("");
    const hooks = await readdir(join(root, ".githooks"));
    const hookText = (await Promise.all(hooks.map((hook) => readFile(join(root, ".githooks", hook), "utf8")))).join("\n");
    const entries = [{ base: "", text: [...Object.values(rootManifest.scripts ?? {}), hookText].join("\n") }];
    for (const workspace of rootManifest.workspaces) {
        entries.push({ base: workspace, text: Object.values((await read(workspace)).scripts ?? {}).join("\n") });
    }
    return entries;
};

const codeFiles = async (directory) => {
    let entries;
    try { entries = await readdir(join(root, directory), { withFileTypes: true }); } catch { return []; }
    return entries.filter((entry) => entry.isFile() && isCode(entry.name)).map((entry) => entry.name);
};

// A file is named when its own package spells `scripts/<name>` (a root file may be spelled `../scripts/<name>`
// by a workspace), or when any package spells its path from the root (`plurnk-core/scripts/sql-report.mjs`).
const named = (all, own, relative) => own.text.includes(relative)
    || all.some((each) => each.text.includes(own.base === "" ? relative : join(own.base, relative)));

test("{§scripts-layout} every code file at the top of a scripts/ directory, or under the root's audit/, is named by a package.json script or a git hook", async () => {
    const all = await packages();
    let seen = 0;
    for (const own of all) {
        for (const directory of own.base === "" ? ["scripts", "scripts/audit"] : ["scripts"]) {
            for (const name of await codeFiles(join(own.base, directory))) {
                const relative = join(directory, name);
                seen += 1;
                assert.ok(named(all, own, relative), `${join(own.base, relative)}: nothing names it; a module belongs under scripts/lib/`);
            }
        }
    }
    assert.ok(seen >= 40, `found ${seen} entry points`);
});

test("{§scripts-layout} nothing names a module under a scripts/lib/", async () => {
    const all = await packages();
    let seen = 0;
    for (const own of all) {
        for (const name of await codeFiles(join(own.base, "scripts/lib"))) {
            const relative = join("scripts/lib", name);
            seen += 1;
            assert.ok(!named(all, own, relative), `${join(own.base, relative)}: a package.json script or a hook names it; an entry point belongs at the top of scripts/`);
        }
    }
    assert.ok(seen >= 20, `found ${seen} modules`);
});
