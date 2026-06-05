// Slice 2 of the OO audit: rewrite callers of the former _entry-* free
// functions onto the new static-method classes. Call-site rule is guarded
// — `(?<!async )(?<![\w.])SYM\b(?=\()` — so it skips `async readEntry(`
// method DEFS and `src.readEntry(` instance calls (the schemes expose
// readEntry/writeEntry/deleteEntry methods that collide with EntryCrud's
// names). Verified by tsc + the test run.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class EntryOoCodemod {
    static #REPO = join(import.meta.dirname, "..");

    static #MAP = {
        editSessionEntry: "EntryOps",
        readSessionEntry: "EntryOps",
        showSessionEntry: "EntryOps",
        hideSessionEntry: "EntryOps",
        readEntry: "EntryCrud",
        writeEntry: "EntryCrud",
        deleteEntry: "EntryCrud",
        findSessionEntries: "EntryFind",
        buildManifestBody: "EntryManifest",
        sendToSessionEntry: "EntrySend",
    };

    static #FILES = [
        "src/core/git-membership.ts",
        "src/core/Engine.ts",
        "src/schemes/Plurnk.ts",
        "src/schemes/Known.ts",
        "src/schemes/Unknown.ts",
        "src/schemes/Skill.ts",
        "src/schemes/File.ts",
        "src/schemes/Exec.ts",
    ];

    static async run() {
        const symbols = Object.keys(EntryOoCodemod.#MAP).sort((a, b) => b.length - a.length);
        const importRe = /^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";\s*$/;

        for (const relPath of EntryOoCodemod.#FILES) {
            const full = join(EntryOoCodemod.#REPO, relPath);
            let text;
            try { text = await readFile(full, "utf8"); }
            catch { console.log(`SKIP (missing) ${relPath}`); continue; }

            const lines = text.split("\n");
            const byPath = new Map();
            const matched = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith("import type")) continue;
                const m = line.match(importRe);
                if (!m) continue;
                const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
                if (!names.some((n) => n in EntryOoCodemod.#MAP)) continue;
                const path = m[2];
                if (!byPath.has(path)) byPath.set(path, { classes: new Set(), rest: new Set() });
                const bucket = byPath.get(path);
                for (const n of names) {
                    if (n in EntryOoCodemod.#MAP) bucket.classes.add(EntryOoCodemod.#MAP[n]);
                    else bucket.rest.add(n);
                }
                matched.push(i);
            }

            if (matched.length > 0) {
                const blocks = [];
                for (const [path, { classes, rest }] of byPath) {
                    for (const c of [...classes].sort()) blocks.push(`import ${c} from "${path}";`);
                    if (rest.size > 0) blocks.push(`import { ${[...rest].join(", ")} } from "${path}";`);
                }
                lines[matched[0]] = blocks.join("\n");
                for (let k = 1; k < matched.length; k++) lines[matched[k]] = " RM ";
            }

            let out = lines.filter((l) => l !== " RM ").join("\n");
            for (const sym of symbols) {
                const re = new RegExp(`(?<!async )(?<![\\w.])${sym}\\b(?=\\()`, "g");
                out = out.replace(re, `${EntryOoCodemod.#MAP[sym]}.${sym}`);
            }

            await writeFile(full, out);
            console.log(`patched ${relPath}`);
        }
    }
}

await EntryOoCodemod.run();
