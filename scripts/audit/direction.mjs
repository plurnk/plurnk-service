// Import-direction audit (#891): dependency-cruiser over every workspace's runtime source under
// `dependency-cruiser.mjs`. On demand: `npm run audit:direction`; never a gate.
// dependency-cruiser has no TypeScript 7 transpiler yet, so it cannot mark type-only edges itself;
// this wrapper reads the sources' `import type` statements and drops every cycle that a type-only
// hop closes, since that edge is erased at runtime.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import configuration from "./dependency-cruiser.mjs";

const root = resolve(import.meta.dirname, "../..");
process.chdir(root);
const sources = readdirSync(root).filter((name) => name.startsWith("plurnk-")).map((name) => `${name}/src`);

// The API takes resolver options as their own argument; the CLI folds them in from the config.
const { enhancedResolveOptions, ...options } = configuration.options;
const { output } = await cruise(sources, {
    ...options,
    ruleSet: { forbidden: configuration.forbidden },
    validate: true,
    outputType: "json",
}, enhancedResolveOptions);
const { modules, summary } = JSON.parse(output);

// specifier → true when every import of it in the file is type-only.
const typeOnlyImports = (source) => {
    const statements = new Map();
    const record = (specifier, typeOnly) => statements.set(specifier, (statements.get(specifier) ?? true) && typeOnly);
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s+type\b[^;]*?\bfrom\s*["']([^"']+)["']/gmu)) record(specifier, true);
    for (const [, names, specifier] of source.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gmu)) {
        record(specifier, names.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type ")));
    }
    for (const [, specifier] of source.matchAll(/^\s*import\s+(?!type\b)[^{;]*?\bfrom\s*["']([^"']+)["']/gmu)) record(specifier, false);
    for (const [, specifier] of source.matchAll(/^\s*export\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gmu)) record(specifier, false);
    for (const [, specifier] of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) record(specifier, false);
    return statements;
};
const byName = new Map(modules.map((module) => [module.source, module]));
const typeOnlyEdge = (from, to) => {
    const module = byName.get(from);
    const dependency = module?.dependencies.find(({ resolved }) => resolved === to);
    if (module === undefined || dependency === undefined) return false;
    return typeOnlyImports(readFileSync(resolve(root, from), "utf8")).get(dependency.module) === true;
};

const cycleKey = (names) => { const start = names.indexOf(names.toSorted()[0]); return [...names.slice(start), ...names.slice(0, start)].join(" > "); };
const seen = new Set();
const violations = summary.violations.filter((violation) => {
    if (violation.rule.name !== "no-circular") return true;
    const names = [violation.from, ...violation.cycle.map((hop) => hop.name).filter((name) => name !== violation.from)];
    const hops = names.map((name, index) => [name, names[(index + 1) % names.length]]);
    if (hops.some(([from, to]) => typeOnlyEdge(from, to))) return false;
    const key = cycleKey(names);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
});

for (const violation of violations) {
    const cycle = violation.rule.name === "no-circular" ? `  ${cycleKey([violation.from, ...violation.cycle.map((hop) => hop.name).filter((name) => name !== violation.from)])}` : "";
    console.log(`${violation.rule.name}: ${violation.from} -> ${violation.to}${cycle}`);
}
const unresolvable = modules.filter((module) => module.couldNotResolve).map((module) => module.source);
if (unresolvable.length > 0) console.log(`unresolvable (${unresolvable.length}): ${unresolvable.join(", ")}`);
const ownership = violations.filter((violation) => violation.rule.name !== "no-circular").length;
console.log(`audit:direction — ${ownership} ownership violation(s), ${violations.length - ownership} runtime cycle(s) over ${modules.length} modules`);
process.exitCode = violations.length > 0 ? 1 : 0;
