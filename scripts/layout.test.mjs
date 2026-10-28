import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectDirections } from "./audit/direction.mjs";

const root = join(import.meta.dirname, "..");
const rootUrl = new URL("../", import.meta.url);
const CODE = /\.(?:mjs|js|ts|mts|sh)$/u;
const isCode = (name) => CODE.test(name) && !/\.test\.[^.]+$/u.test(name) && !name.endsWith(".d.mts");

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
    assert.ok(seen > 0);
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
    assert.ok(seen > 0);
});

const teaching = await readFile(join(root, "AGENTS.md"), "utf8");
const manifestOf = async (directory) => JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
const rootManifest = await manifestOf("");
const allPackages = new Map([["", rootManifest]]);
for (const workspace of rootManifest.workspaces) allPackages.set(workspace, await manifestOf(workspace));
const directoryOf = (target) => {
    for (const [directory, manifest] of allPackages) if (manifest.name === target || directory === target) return directory;
    return undefined;
};
const everyScript = new Set([...allPackages.values()].flatMap((manifest) => Object.keys(manifest.scripts ?? {})));
const tokens = [...teaching.matchAll(/`([^`\n]+)`/gu)].map(([, token]) => token);

test("{§scripts-layout} every npm command AGENTS.md spells is a script of the package it names", () => {
    const mentions = [...teaching.matchAll(/npm (?:run(?: -s)?\s+([\w:.-]+)|(test|start)\b)(?:[^`\n]*?(?:-w|--workspace)[ =]([@\w/.-]+))?/gu)];
    assert.ok(mentions.length >= 10, `found ${mentions.length} npm commands`);
    for (const [spelled, name, bare, target] of mentions) {
        const script = name ?? bare;
        const directory = target === undefined ? "" : directoryOf(target);
        assert.notEqual(directory, undefined, `${spelled}: ${target} is not a workspace`);
        const scripts = Object.keys(allPackages.get(directory).scripts ?? {});
        assert.ok(scripts.includes(script), `${spelled}: ${script} is not a script of ${directory || "the root"}`);
    }
});

test("{§scripts-layout} every script name AGENTS.md mentions exists in some package", () => {
    const names = tokens.filter((token) => /^[a-z][\w-]*(?::[\w-]+)+$/u.test(token));
    assert.ok(names.length >= 5, `found ${names.length} script names`);
    for (const name of names) assert.ok(everyScript.has(name), `${name}: no package.json has this script`);
});

test("{§scripts-layout} every repository path AGENTS.md names exists", async () => {
    const paths = tokens.filter((token) => /^(?:[\w.-]+\/)+[\w.-]+$/u.test(token) && !/^(?:\.\.|@|~|\$)/u.test(token));
    assert.ok(paths.length >= 10, `found ${paths.length} paths`);
    for (const rel of paths) await assert.doesNotReject(access(join(root, rel)), `${rel}: named by AGENTS.md but absent`);
});

test("{§native-source-toolchain} the root pins the ordinary Node and npm toolchain", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
    assert.equal(manifest.engines.node, ">=26");
    assert.equal(manifest.packageManager, "npm@12.2.0");
    assert.equal(manifest.scripts.prepare, "git config core.hooksPath .githooks && npm run build");
    assert.equal(manifest.scripts["config:defaults"], "node --conditions=plurnk-dev plurnk-core/src/service.ts config defaults");
    assert.equal(await readFile(new URL(".node-version", rootUrl), "utf8"), "26\n");
});

test("{§native-source-toolchain} source checking has one modern ECMAScript module contract", async () => {
    const { compilerOptions } = JSON.parse(await readFile(new URL("tsconfig.base.json", rootUrl), "utf8"));
    assert.equal(compilerOptions.target, "ESNext");
    assert.deepEqual(compilerOptions.lib, ["ESNext"]);
    assert.equal(compilerOptions.module, "NodeNext");
    assert.equal(compilerOptions.moduleResolution, "NodeNext");
    assert.equal(compilerOptions.erasableSyntaxOnly, true);
    assert.equal(compilerOptions.verbatimModuleSyntax, true);
    const { workspaces } = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
    for (const workspace of workspaces.filter((name) => name !== "plurnk-spec-check")) {
        const config = JSON.parse(await readFile(new URL(`${workspace}/tsconfig.json`, rootUrl), "utf8"));
        assert.equal(config.extends, "../tsconfig.base.json", workspace);
        for (const option of ["target", "lib", "module", "moduleResolution", "erasableSyntaxOnly", "verbatimModuleSyntax"]) {
            assert.equal(Object.hasOwn(config.compilerOptions ?? {}, option), false,
                `${workspace} inherits ${option}; browser-specific checking belongs in its own config`);
        }
    }
});

test("{§lint-gate} every file the type-aware lint reads is in the program of a tsconfig.json", async () => {
    const repository = fileURLToPath(rootUrl);
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8" })
        .split("\n").filter(Boolean);
    const { ignorePatterns } = JSON.parse((await readFile(new URL(".oxlintrc.json", rootUrl), "utf8")).replaceAll(/^\s*\/\/.*$/gmu, ""));
    const ignored = ignorePatterns.map((pattern) => {
        const directory = /^\*\*\/([^/*]+)\/\*\*$/u.exec(pattern)?.[1];
        assert.ok(directory, `${pattern} names one directory`);
        return directory;
    });
    const contained = new Set();
    for (const project of tracked.filter((file) => path.basename(file) === "tsconfig.json")) {
        const program = execFileSync(path.join(repository, "node_modules/.bin/tsc"), ["--listFilesOnly", "-p", project], { cwd: repository, encoding: "utf8" });
        for (const file of program.split("\n").filter(Boolean)) contained.add(path.resolve(repository, file));
    }
    const outside = tracked
        .filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && !path.dirname(file).split("/").some((segment) => ignored.includes(segment)))
        .filter((file) => !contained.has(path.resolve(repository, file)));
    assert.deepEqual(outside, [], "files in no tsconfig.json program");
});

const directionFixture = async (t, sources) => {
    const tempRoot = await mkdtemp(join(tmpdir(), "plurnk-direction-"));
    t.after(() => rm(tempRoot, { recursive: true, force: true }));
    const workspaces = [...new Set(Object.keys(sources).map((name) => name.split("/")[0]))];
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ workspaces, type: "module" }));
    for (const [file, source] of Object.entries(sources)) {
        const input = join(tempRoot, file);
        const output = input.replace("/src/", "/dist/").replace(/\.ts$/u, ".js");
        await mkdir(dirname(input), { recursive: true });
        await mkdir(dirname(output), { recursive: true });
        await writeFile(input, source);
        await writeFile(output, stripTypeScriptTypes(source));
    }
    return tempRoot;
};

test("{§lint-gate} runtime direction audit excludes erased imports and re-exports without interpreting TypeScript", async (t) => {
    const tempRoot = await directionFixture(t, {
        "plurnk-core/src/a.ts": 'import type { B } from "./b.js"; export type { B } from "./b.js"; export type A = B; export const a = 1;',
        "plurnk-core/src/b.ts": 'import { a } from "./a.js"; export type B = number; export const b = a;',
    });
    await writeFile(join(tempRoot, "plurnk-core/dist/a.d.ts"), 'export type A = import("./types.ts").A;');
    const report = await inspectDirections(tempRoot);
    assert.deepEqual(report.violations, []);
    assert.equal(report.modules.length, 2);
    assert.deepEqual(report.modules.find(({ source }) => source.endsWith("/a.js")).dependencies, []);
    assert.equal(report.modules.find(({ source }) => source.endsWith("/b.js")).dependencies.length, 1);
});

test("{§lint-gate} runtime direction audit retains a side-effect edge beside a type-only import", async (t) => {
    const tempRoot = await directionFixture(t, {
        "plurnk-core/src/a.ts": 'import type { B } from "./b.js"; import "./b.js"; export type A = B; export const a = 1;',
        "plurnk-core/src/b.ts": 'import { a } from "./a.js"; export type B = number; export const b = a;',
    });
    const { violations } = await inspectDirections(tempRoot);
    assert.ok(violations.some(({ rule }) => rule.name === "no-circular"));
});

test("{§lint-gate} runtime direction audit enforces owner boundaries on emitted imports", async (t) => {
    const tempRoot = await directionFixture(t, {
        "plurnk-core/src/index.ts": "export const value = 1;",
        "plurnk-parser/src/index.ts": "export const parse = 1;",
        "plurnk-mimetypes/src/index.ts": 'export { value } from "../../plurnk-mimetypes-text-plain/dist/index.js";',
        "plurnk-mimetypes-text-plain/src/index.ts": 'export { value } from "../../plurnk-core/dist/index.js";',
        "plurnk-schedule/src/index.ts": 'export { parse } from "../../plurnk-parser/dist/index.js";',
    });
    const names = new Set((await inspectDirections(tempRoot)).violations.map(({ rule }) => rule.name));
    assert.ok(names.has("no-leaf-to-core"));
    assert.ok(names.has("no-framework-to-own-leaf"));
    assert.ok(names.has("parser-only-where-declared"));
});

test("{§lint-gate} runtime direction audit reports unresolved imports and refuses missing build output", async (t) => {
    const tempRoot = await directionFixture(t, { "plurnk-core/src/a.ts": 'import "./absent.js";' });
    assert.ok((await inspectDirections(tempRoot)).violations.some(({ rule }) => rule.name === "no-unresolved"));
    await rm(join(tempRoot, "plurnk-core/dist"), { recursive: true });
    await assert.rejects(inspectDirections(tempRoot), /plurnk-core.*no built JavaScript/);
});

test("{§lint-gate} runtime direction audit scans shipped JS for dist-less workspaces", async (t) => {
    const tempRoot = await directionFixture(t, { "plurnk-core/src/a.ts": "export const a = 1;" });
    await mkdir(join(tempRoot, "plurnk-spec-check"), { recursive: true });
    await writeFile(join(tempRoot, "plurnk-spec-check/package.json"), JSON.stringify({ files: ["check.mjs", "README.md"] }));
    await writeFile(join(tempRoot, "plurnk-spec-check/check.mjs"), "export const ok = true;");
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ workspaces: ["plurnk-core", "plurnk-spec-check"], type: "module" }));
    const report = await inspectDirections(tempRoot);
    assert.deepEqual(report.violations, []);
    assert.equal(report.modules.length, 2);
});
