// Slice 5 of the OO audit: rewrite callers of the 7 core/ free-function
// modules onto their new classes. Whole-text import regex (handles single-
// AND multi-line `import { ... } from`), per-file imported-symbol tracking,
// guarded call rule. Each value-import statement is from one module → one
// class, so no cross-statement consolidation needed; non-mapped names (types)
// in the same statement are preserved. Verified by tsc + the test run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class CoreOoCodemod {
    static #REPO = join(import.meta.dirname, "..");
    static #MODULE_RE = /\/(ChannelWrite|EnvFlags|git-membership|PluginLoader|ProviderInstantiate|resolveForLoop|results)\.ts$/;

    static #MAP = {
        appendToChannel: "ChannelWrite", setChannelState: "ChannelWrite", openSubscription: "ChannelWrite",
        closeSubscription: "ChannelWrite", findActiveSubscription: "ChannelWrite",
        parseEnvExampleContent: "EnvFlags", parseEnvExample: "EnvFlags", formatFlagsHelp: "EnvFlags",
        resolveGitMembership: "GitMembership", indexGitMembership: "GitMembership",
        discoverPlugins: "PluginLoader", loadPlugin: "PluginLoader", assertIdentityMatch: "PluginLoader",
        instantiateProvider: "ProviderInstantiate", loadActiveProvider: "ProviderInstantiate",
        resolveForLoop: "ResolveForLoop",
        isEntryResult: "Results", isProposalResult: "Results", isPassthroughResult: "Results",
        isErrorStatus: "Results", schemeError: "Results", logCoordinate: "Results",
    };

    static async #walk(dir) {
        const out = [];
        for (const ent of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === ".tmp" || ent.name === "node_modules" || ent.name === ".git") continue;
                out.push(...(await CoreOoCodemod.#walk(full)));
            } else if (/\.(ts|js|mjs)$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
        }
        return out;
    }

    static async run() {
        const roots = ["src", "test", "bin"].map((r) => join(CoreOoCodemod.#REPO, r));
        const files = (await Promise.all(roots.map((r) => CoreOoCodemod.#walk(r)))).flat();
        const importRe = /import\s+\{([^}]*)\}\s+from\s+"([^"]+)";/g;

        for (const full of files) {
            let text = await readFile(full, "utf8");
            const imported = new Set();
            text = text.replace(importRe, (m, names, path) => {
                if (!CoreOoCodemod.#MODULE_RE.test(path)) return m;
                const syms = names.split(",").map((s) => s.trim()).filter(Boolean);
                const mapped = syms.filter((s) => s in CoreOoCodemod.#MAP);
                if (mapped.length === 0) return m;
                const cls = CoreOoCodemod.#MAP[mapped[0]];
                for (const s of mapped) imported.add(s);
                const rest = syms.filter((s) => !(s in CoreOoCodemod.#MAP));
                let out = `import ${cls} from "${path}";`;
                if (rest.length > 0) out += `\nimport { ${rest.join(", ")} } from "${path}";`;
                return out;
            });
            if (imported.size === 0) continue;

            for (const sym of [...imported].sort((a, b) => b.length - a.length)) {
                const re = new RegExp(`(?<!async )(?<![\\w.])${sym}\\b(?=\\()`, "g");
                text = text.replace(re, `${CoreOoCodemod.#MAP[sym]}.${sym}`);
            }
            await writeFile(full, text);
            console.log(`patched ${full.slice(CoreOoCodemod.#REPO.length + 1)}`);
        }
    }
}

await CoreOoCodemod.run();
