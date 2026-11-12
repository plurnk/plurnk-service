import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TREE_SITTER_REGISTRY } from "../plurnk-mimetypes/src/treesitter/registry.ts";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: node scripts/dependency-policy.mjs   (a step of npm run root:lint)
Checks the dependency graph: a framework never depends on an extension of its kind ({§core-extension-composition}), every package with install scripts is reviewed, no cycles.
Reads: every package.json and the installed tree.
Writes: violations to stdout; exit 1 on any.
`);

const run = promisify(execFile);

// {§core-extension-composition}: frameworks own contracts and discovery,
// never runtime edges to the extensions of their kind. The composed host's
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

// {§mimetype-grammar-packages} — non-optional grammars ship in optionalDependencies ({§bundled-set});
// opt-in grammars (`optional: true`) stay outside the default set.
export const defaultGrammarViolations = (manifest) => [
    ...[...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional !== true).map(({ slug }) =>
        `@plurnk/plurnk-mimetypes-grammar-${slug}`))]
        .filter((name) => !Object.hasOwn(manifest.optionalDependencies ?? {}, name))
        .map((name) => `plurnk-core/package.json: optionalDependencies.${name} is required by {§bundled-set}`),
    ...[...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional !== true).map(({ slug }) =>
        `@plurnk/plurnk-mimetypes-grammar-${slug}`))]
        .filter((name) => Object.hasOwn(manifest.dependencies ?? {}, name))
        .map((name) => `plurnk-core/package.json: dependencies.${name} must be declared in optionalDependencies ({§bundled-set})`),
    ...[...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional === true).map(({ slug }) =>
        `@plurnk/plurnk-mimetypes-grammar-${slug}`))]
        .flatMap((name) => ["dependencies", "optionalDependencies"]
            .filter((section) => Object.hasOwn(manifest[section] ?? {}, name))
            .map((section) => `plurnk-core/package.json: ${section}.${name} is an optional grammar package and must not ship by default ({§mimetype-grammar-packages})`)),
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
        for (const target of new Set(targets.map((edge) => edge.target))) fanIn.set(target, fanIn.get(target) + 1);
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
            violations.push(`package cycle among ${component.toSorted().join(", ")}, against the Acyclic Dependencies principle (ARCHITECTURE.md § Package principles)`);
        }
    };
    for (const name of [...names].toSorted()) if (!order.has(name)) visit(name);
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

// {§module-seam-slices} — a module states its compatibility with the contract as a peer range; the
// host, which implements the contract, is the one package that depends on it.
const MODULE_CONTRACT = "@plurnk/plurnk-modules";
const MODULE_HOST = "@plurnk/plurnk-service";
export const moduleContractViolations = (entries) => entries
    .filter(({ manifest, importsContract }) => importsContract && manifest.name !== MODULE_HOST && manifest.name !== MODULE_CONTRACT)
    .flatMap(({ file, manifest }) => [
        ...(Object.hasOwn(manifest.peerDependencies ?? {}, MODULE_CONTRACT) ? [] : [`${file}: a module declares ${MODULE_CONTRACT} as a peer dependency ({§module-seam-slices})`]),
        ...(Object.hasOwn(manifest.dependencies ?? {}, MODULE_CONTRACT) ? [`${file}: dependencies.${MODULE_CONTRACT} must be a peer dependency ({§module-seam-slices})`] : []),
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

// {§release-candidate-graph} — Watched protocol dependencies (@agentclientprotocol/*, @modelcontextprotocol/*)
// must be recorded in deps-waivers.json with their pin requirement (exact or caret), resolved lockfile version,
// verifiedLatest, verifiedAt, budgetDays, and rationale (#1359).
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const WATCHED_DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
export const watchedDependencyViolations = ({ policy, workspaceManifests, lockfile }) => {
    const violations = [];
    const watched = Array.isArray(policy?.watched) ? policy.watched : [];
    const watchedFamilies = Array.isArray(policy?.watchedFamilies) ? policy.watchedFamilies : [];
    const waivers = policy?.waivers ?? {};
    const ownerVeto = new Set(Array.isArray(policy?.ownerVeto) ? policy.ownerVeto : []);

    if (watched.length === 0) {
        violations.push("deps-waivers.json: watched list must not be empty");
    }

    const byDir = new Map(workspaceManifests.map(({ file, manifest }) => [path.dirname(file), manifest]));
    const watchedByName = new Map();

    for (const entry of watched) {
        const { name, workspaces = [], requirement, resolved, verifiedLatest, verifiedAt, budgetDays, why } = entry ?? {};
        if (typeof name !== "string" || name.length === 0) {
            violations.push("deps-waivers.json: watched entry is missing a package name");
            continue;
        }
        watchedByName.set(name, entry);
        if (!Object.hasOwn(waivers, name) && !ownerVeto.has(name)) {
            violations.push(`deps-waivers.json: unwaived watched dependency ${name} must be listed in ownerVeto`);
        }
        if (typeof why !== "string" || why.trim().length === 0) {
            violations.push(`deps-waivers.json: ${name} is missing a non-empty 'why' rationale`);
        }
        if (!SEMVER_RE.test(String(resolved))) {
            violations.push(`deps-waivers.json: ${name}.resolved '${String(resolved)}' is not an exact semver`);
        }
        if (!SEMVER_RE.test(String(verifiedLatest))) {
            violations.push(`deps-waivers.json: ${name}.verifiedLatest '${String(verifiedLatest)}' is not an exact semver`);
        }
        if (resolved !== verifiedLatest) {
            violations.push(`deps-waivers.json: ${name}.resolved (${String(resolved)}) does not match verifiedLatest (${String(verifiedLatest)})`);
        }
        if (!DATE_RE.test(String(verifiedAt)) || Number.isNaN(Date.parse(`${String(verifiedAt)}T00:00:00Z`))) {
            violations.push(`deps-waivers.json: ${name}.verifiedAt '${String(verifiedAt)}' must be YYYY-MM-DD`);
        }
        if (!Number.isSafeInteger(budgetDays) || budgetDays <= 0 || budgetDays > 30) {
            violations.push(`deps-waivers.json: ${name}.budgetDays must be an integer in 1..30`);
        }
        if (!Array.isArray(workspaces) || workspaces.length === 0) {
            violations.push(`deps-waivers.json: ${name}.workspaces must list at least one workspace`);
        }
        const expectedSpec = requirement === "exact"
            ? String(resolved)
            : requirement === "caret"
                ? `^${String(resolved)}`
                : null;
        if (expectedSpec === null) {
            violations.push(`deps-waivers.json: ${name}.requirement '${String(requirement)}' must be 'exact' or 'caret'`);
        } else {
            for (const dir of workspaces) {
                const manifest = byDir.get(dir);
                if (!manifest) {
                    violations.push(`deps-waivers.json: ${name} names unknown workspace '${String(dir)}'`);
                    continue;
                }
                const specs = WATCHED_DEP_SECTIONS
                    .map((section) => manifest[section]?.[name])
                    .filter((spec) => spec !== undefined);
                if (specs.length === 0) {
                    violations.push(`${String(dir)}/package.json: missing watched dependency ${name}`);
                } else if (specs[0] !== expectedSpec) {
                    violations.push(`${String(dir)}/package.json: ${name} requires '${expectedSpec}', found '${String(specs[0])}'`);
                }
            }
        }
        const lockEntry = lockfile?.packages?.[`node_modules/${name}`];
        if (!lockEntry || typeof lockEntry.version !== "string") {
            violations.push(`package-lock.json: missing node_modules/${name} resolution`);
        } else if (lockEntry.version !== resolved) {
            violations.push(`package-lock.json: node_modules/${name} resolves to '${lockEntry.version}', expected '${String(resolved)}' from deps-waivers.json`);
        }
    }

    for (const { file, manifest } of workspaceManifests) {
        const dir = path.dirname(file);
        for (const section of WATCHED_DEP_SECTIONS) {
            for (const name of Object.keys(manifest[section] ?? {})) {
                if (!watchedFamilies.some((prefix) => name.startsWith(prefix))) continue;
                const entry = watchedByName.get(name);
                if (!entry) {
                    violations.push(`${file}: ${section}.${name} belongs to watched family (${watchedFamilies.join(", ")}) and must be listed in deps-waivers.json`);
                } else if (!Array.isArray(entry.workspaces) || !entry.workspaces.includes(dir)) {
                    violations.push(`${file}: ${section}.${name} is declared in ${dir} but deps-waivers.json does not list '${dir}' in ${name}.workspaces`);
                }
            }
        }
    }

    return violations;
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
                        violations.push(`${file}: ${section}.${name} makes the framework depend on an extension of its kind`);
                    }
                }
            }
        }
    }

    const [policyRaw, lockfileRaw] = await Promise.all([
        fs.readFile("deps-waivers.json", "utf8"),
        fs.readFile("package-lock.json", "utf8"),
    ]);
    violations.push(...watchedDependencyViolations({
        policy: JSON.parse(policyRaw),
        workspaceManifests,
        lockfile: JSON.parse(lockfileRaw),
    }));
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
