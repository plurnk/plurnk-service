// {§agents-map} — AGENTS.md is rules plus a map; the map names only commands and paths that exist.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const teaching = await readFile(join(root, "AGENTS.md"), "utf8");
const manifestOf = async (directory) => JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
const rootManifest = await manifestOf("");
const packages = new Map([["", rootManifest]]);
for (const workspace of rootManifest.workspaces) packages.set(workspace, await manifestOf(workspace));
const directoryOf = (target) => {
    for (const [directory, manifest] of packages) if (manifest.name === target || directory === target) return directory;
    return undefined;
};
const everyScript = new Set([...packages.values()].flatMap((manifest) => Object.keys(manifest.scripts ?? {})));
const tokens = [...teaching.matchAll(/`([^`\n]+)`/gu)].map(([, token]) => token);

test("{§agents-map} every npm command AGENTS.md spells is a script of the package it names", () => {
    const mentions = [...teaching.matchAll(/npm (?:run(?: -s)?\s+([\w:.-]+)|(test|start)\b)(?:[^`\n]*?(?:-w|--workspace)[ =]([@\w/.-]+))?/gu)];
    assert.ok(mentions.length >= 10, `found ${mentions.length} npm commands`);
    for (const [spelled, name, bare, target] of mentions) {
        const script = name ?? bare;
        const directory = target === undefined ? "" : directoryOf(target);
        assert.notEqual(directory, undefined, `${spelled}: ${target} is not a workspace`);
        const scripts = Object.keys(packages.get(directory).scripts ?? {});
        assert.ok(scripts.includes(script), `${spelled}: ${script} is not a script of ${directory || "the root"}`);
    }
});

test("{§agents-map} every script name AGENTS.md mentions exists in some package", () => {
    const names = tokens.filter((token) => /^[a-z][\w-]*(?::[\w-]+)+$/u.test(token));
    assert.ok(names.length >= 5, `found ${names.length} script names`);
    for (const name of names) assert.ok(everyScript.has(name), `${name}: no package.json has this script`);
});

test("{§agents-map} every repository path AGENTS.md names exists", async () => {
    const paths = tokens.filter((token) => /^(?:[\w.-]+\/)+[\w.-]+$/u.test(token) && !/^(?:\.\.|@|~|\$)/u.test(token));
    assert.ok(paths.length >= 10, `found ${paths.length} paths`);
    for (const path of paths) await assert.doesNotReject(access(join(root, path)), `${path}: named by AGENTS.md but absent`);
});
