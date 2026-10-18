import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// {§scripts-layout} — what a person runs sits at the top of scripts/ and under audit/; what those
// import sits under lib/. "Named" means a package.json script or a git hook spells the path.
const root = join(import.meta.dirname, "..");
const CODE = /\.(?:mjs|js|ts|mts|sh)$/u;
const isCode = (name) => CODE.test(name) && !/\.test\.[^.]+$/u.test(name) && !name.endsWith(".d.mts");

const namers = async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const manifests = [manifest, ...await Promise.all(manifest.workspaces.map(
        async (workspace) => JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8")),
    ))];
    const hooks = await readdir(join(root, ".githooks"));
    return [
        ...manifests.flatMap((each) => Object.values(each.scripts ?? {})),
        ...await Promise.all(hooks.map((hook) => readFile(join(root, ".githooks", hook), "utf8"))),
    ].join("\n");
};

const codeFiles = async (directory) => (await readdir(join(root, "scripts", directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isCode(entry.name))
    .map((entry) => join("scripts", directory, entry.name));

test("{§scripts-layout} every code file at the top of scripts/ and under audit/ is named by a package.json script or a git hook", async () => {
    const named = await namers();
    const files = [...await codeFiles(""), ...await codeFiles("audit")];
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.ok(named.includes(file), `${file}: nothing names it; a module belongs under scripts/lib/`);
    }
});

test("{§scripts-layout} nothing names a module under scripts/lib/", async () => {
    const named = await namers();
    const files = await codeFiles("lib");
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.ok(!named.includes(file), `${file}: a package.json script or a hook names it; an entry point belongs at the top of scripts/`);
    }
});
