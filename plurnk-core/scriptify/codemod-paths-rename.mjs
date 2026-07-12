// Closing axis 1: PATHS const (moved from index.ts into the Paths class at
// src/Paths.ts) → rename every `PATHS` reference to `Paths`. Files without the
// token are skipped; index.ts/Paths.ts already use the class name so they
// never match. Verified by tsc.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class PathsRenameCodemod {
    static #REPO = join(import.meta.dirname, "..");

    static async #walk(dir) {
        const out = [];
        for (const ent of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === ".tmp" || ent.name === "node_modules" || ent.name === ".git") continue;
                out.push(...(await PathsRenameCodemod.#walk(full)));
            } else if (/\.(ts|js|mjs)$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
        }
        return out;
    }

    static async run() {
        const roots = ["src", "test", "bin"].map((r) => join(PathsRenameCodemod.#REPO, r));
        const files = (await Promise.all(roots.map((r) => PathsRenameCodemod.#walk(r)))).flat();
        for (const full of files) {
            const text = await readFile(full, "utf8");
            if (!/\bPATHS\b/.test(text)) continue;
            await writeFile(full, text.replace(/\bPATHS\b/g, "Paths"));
            console.log(`patched ${full.slice(PathsRenameCodemod.#REPO.length + 1)}`);
        }
    }
}

await PathsRenameCodemod.run();
