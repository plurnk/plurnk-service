import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TREE_SITTER_REGISTRY } from "../plurnk-mimetypes/src/treesitter/registry.ts";

const run = promisify(execFile);

// {§core-plugin-composition}: capability frameworks own contracts and
// discovery, never runtime edges to their leaf consumers. The composed host's
// manifest is the one default-inventory owner ({§bundled-set}).
const leanFrameworks = new Map([
    ["plurnk-mimetypes/package.json", "@plurnk/plurnk-mimetypes-"],
    ["plurnk-execs/package.json", "@plurnk/plurnk-execs-"],
    ["plurnk-schemes/package.json", "@plurnk/plurnk-schemes-"],
]);

export const installScriptViolations = (report) => {
    if (!Array.isArray(report?.allowScripts)) {
        throw new TypeError("npm install-scripts returned an invalid allowScripts report");
    }
    return report.allowScripts.flatMap(({ name, changes = [] }) => changes.map(({ key }) =>
        `package.json: allowScripts does not review ${key ?? name}`));
};

export const workspaceNpmConfigViolations = (files) => files.map((file) =>
    `${file}: npm ignores workspace-local configuration; declare repository policy in the root .npmrc`);

// {§mimetype-optional-grammars} — an optional grammar is neither required nor permitted in the
// default set: the operator installs its leaf beside the service.
export const defaultGrammarViolations = (manifest) => [
    ...[...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional !== true).map(({ slug }) =>
        `@plurnk/plurnk-mimetypes-grammar-${slug}`))]
        .filter((name) => !Object.hasOwn(manifest.dependencies ?? {}, name))
        .map((name) => `plurnk-core/package.json: dependencies.${name} is required by {§default-plugin-ownership}`),
    ...[...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional === true).map(({ slug }) =>
        `@plurnk/plurnk-mimetypes-grammar-${slug}`))]
        .filter((name) => Object.hasOwn(manifest.dependencies ?? {}, name))
        .map((name) => `plurnk-core/package.json: dependencies.${name} is an optional grammar leaf and must not ship by default ({§mimetype-optional-grammars})`),
];

// ARCHITECTURE.md § Package principles — over plurnk dependencies and peer dependencies, the package
// graph has no cycles and depends only toward stability. Instability is a package's plurnk
// dependencies over its dependencies plus dependents, compared as exact fractions.
const GRAPH_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];
export const packageGraphViolations = (entries) => {
    const names = new Set(entries.map(({ manifest }) => manifest.name));
    const edges = new Map(entries.map(({ file, manifest }) => [manifest.name, {
        file,
        targets: GRAPH_SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {})
            .filter((target) => names.has(target))
            .map((target) => ({ target, section }))),
    }]));
    const fanIn = new Map([...names].map((name) => [name, 0]));
    for (const { targets } of edges.values()) {
        for (const target of new Set(targets.map(({ target }) => target))) fanIn.set(target, fanIn.get(target) + 1);
    }
    const fanOut = (name) => new Set(edges.get(name).targets.map(({ target }) => target)).size;
    const violations = [];
    // Tarjan's strongly connected components: a component of more than one package is a cycle.
    const order = new Map();
    const low = new Map();
    const stack = [];
    const visit = (name) => {
        order.set(name, order.size);
        low.set(name, order.get(name));
        stack.push(name);
        for (const { target } of edges.get(name).targets) {
            if (!order.has(target)) {
                visit(target);
                low.set(name, Math.min(low.get(name), low.get(target)));
            } else if (stack.includes(target)) {
                low.set(name, Math.min(low.get(name), order.get(target)));
            }
        }
        if (low.get(name) !== order.get(name)) return;
        const component = stack.splice(stack.indexOf(name));
        if (component.length > 1 || edges.get(name).targets.some(({ target }) => target === name)) {
            violations.push(`package cycle among ${component.sort().join(", ")}, against the Acyclic Dependencies principle (ARCHITECTURE.md § Package principles)`);
        }
    };
    for (const name of [...names].sort()) if (!order.has(name)) visit(name);
    for (const [source, { file, targets }] of edges) {
        const out = fanOut(source);
        const all = out + fanIn.get(source);
        for (const { target, section } of targets) {
            const targetOut = fanOut(target);
            const targetAll = targetOut + fanIn.get(target);
            if (targetOut * all > out * targetAll) {
                violations.push(`${file}: ${section}.${target} is less stable than this package (instability ${targetOut}/${targetAll} against ${out}/${all}), against the Stable Dependencies principle (ARCHITECTURE.md § Package principles)`);
            }
        }
    }
    return violations;
};

// {§module-compatibility} — a module states its compatibility with the contract as a peer range; the
// host, which implements the contract, is the one package that depends on it.
const MODULE_CONTRACT = "@plurnk/plurnk-modules";
const MODULE_HOST = "@plurnk/plurnk-service";
export const moduleContractViolations = (entries) => entries
    .filter(({ manifest, importsContract }) => importsContract && manifest.name !== MODULE_HOST && manifest.name !== MODULE_CONTRACT)
    .flatMap(({ file, manifest }) => [
        ...(Object.hasOwn(manifest.peerDependencies ?? {}, MODULE_CONTRACT) ? [] : [`${file}: a module declares ${MODULE_CONTRACT} as a peer dependency ({§module-compatibility})`]),
        ...(Object.hasOwn(manifest.dependencies ?? {}, MODULE_CONTRACT) ? [`${file}: dependencies.${MODULE_CONTRACT} must be a peer dependency ({§module-compatibility})`] : []),
    ]);

const importsModuleContract = async (dir) => {
    const files = await fs.readdir(path.join(dir, "src"), { recursive: true }).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
    });
    for (const file of files) {
        if (!/\.(?:ts|mts|js|mjs)$/u.test(file)) continue;
        if ((await fs.readFile(path.join(dir, "src", file), "utf8")).includes(`"${MODULE_CONTRACT}"`)) return true;
    }
    return false;
};

if (import.meta.main) {
    const root = JSON.parse(await fs.readFile("package.json", "utf8"));
    const manifests = ["package.json", ...root.workspaces.map((dir) => path.join(dir, "package.json"))];
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"];
    const forbidden = /^(?:@tree-sitter-grammars\/)?tree-sitter(?:-|$)/;
    const { stdout: installScriptReport } = await run("npm", ["install-scripts", "ls", "--json"]);
    const violations = installScriptViolations(JSON.parse(installScriptReport));
    const workspaceNpmConfigs = (await Promise.all(root.workspaces.map((dir) => {
        const file = path.join(dir, ".npmrc");
        return fs.stat(file).then(() => file, (error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
        });
    }))).filter((file) => file !== null);
    violations.push(...workspaceNpmConfigViolations(workspaceNpmConfigs));

    const workspaceManifests = [];
    for (const file of manifests) {
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        if (file !== "package.json") workspaceManifests.push({ file, manifest });
        if (file === "plurnk-core/package.json") violations.push(...defaultGrammarViolations(manifest));
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
            if (typeof command === "string" && /\bnpm outdated\b/.test(command)) {
                violations.push(`${file}: scripts.${name} duplicates the root release freshness gate`);
            }
        }
        for (const section of sections) {
            for (const name of Object.keys(manifest[section] ?? {})) {
                if (name !== "web-tree-sitter" && forbidden.test(name)) {
                    violations.push(`${file}: ${section}.${name}`);
                }
            }
        }
        const leafPrefix = leanFrameworks.get(file);
        if (leafPrefix !== undefined) {
            for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
                for (const name of Object.keys(manifest[section] ?? {})) {
                    if (name.startsWith(leafPrefix)) {
                        violations.push(`${file}: ${section}.${name} makes the framework depend on a leaf consumer`);
                    }
                }
            }
        }
    }

    violations.push(...packageGraphViolations(workspaceManifests));
    violations.push(...moduleContractViolations(await Promise.all(workspaceManifests.map(async (entry) => ({
        ...entry, importsContract: await importsModuleContract(path.dirname(entry.file)),
    })))));

    if (violations.length > 0) {
        console.error("Dependency policy violations:");
        for (const violation of violations) console.error(`  ${violation}`);
        process.exit(1);
    }

    console.log("dependency policy OK");
}
