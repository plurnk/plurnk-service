// Runtime imports are the compiler's output, not a second interpretation of TypeScript (#1053).
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import configuration from "./dependency-cruiser.mjs";

export const inspectDirections = async (root) => {
    const { workspaces } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const sources = [];
    for (const workspace of workspaces) {
        const directory = resolve(root, workspace, "dist");
        const files = await Array.fromAsync(glob("**/*.{js,mjs,cjs}", { cwd: directory }));
        if (files.length === 0) throw new Error(`${workspace}: no built JavaScript; run npm run build first`);
        sources.push(...files.map((file) => resolve(directory, file)));
    }
    const { enhancedResolveOptions, ...options } = configuration.options;
    // dependency-cruiser resolves entry paths against cwd, even with an explicit baseDir.
    // This is a single-process CLI audit, not a concurrent application service.
    const previous = process.cwd();
    process.chdir(root);
    try {
        const { output } = await cruise(sources, {
            ...options,
            baseDir: root,
            ruleSet: { forbidden: configuration.forbidden },
            validate: true,
            outputType: "json",
        }, enhancedResolveOptions);
        const { modules, summary } = JSON.parse(output);
        return { modules, violations: summary.violations, diagnostics: summary.environment.issues ?? [] };
    } finally {
        process.chdir(previous);
    }
};

if (import.meta.main) {
    const { modules, violations, diagnostics } = await inspectDirections(resolve(import.meta.dirname, "../.."));
    for (const { severity, name, description } of diagnostics) console.error(`${severity}: ${name}: ${description}`);
    for (const violation of violations) console.log(`${violation.rule.name}: ${violation.from} -> ${violation.to}`);
    const cycles = violations.filter(({ rule }) => rule.name === "no-circular").length;
    console.log(`audit:direction — ${violations.length - cycles} import violation(s), ${cycles} runtime cycle report(s) over ${modules.length} built modules`);
    process.exitCode = violations.length > 0 || diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
}
