// Slice 4 of the OO audit: rewrite callers of the server/ top-level free
// functions (dsl, envelope, clientTurn, logEntry, yolo) onto the new classes.
// Per-file imported-symbol tracking: a symbol is only prefixed where it was
// STATICALLY imported from one of the five modules in that file — so local
// same-named functions and dynamic `await import` destructures are left alone
// (the latter hand-fixed). Guarded call rule skips method-defs/instance-calls.
// Verified by tsc + the test run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class ServerTopOoCodemod {
    static #REPO = join(import.meta.dirname, "..");
    static #MODULE_RE = /\/(dsl|envelope|clientTurn|logEntry|yolo)\.ts$/;

    static #MAP = {
        insertClientTurn: "ClientTurn",
        parseSingleStatement: "Dsl", parseAllStatements: "Dsl",
        buildEdit: "Dsl", buildRead: "Dsl", buildFind: "Dsl", buildShow: "Dsl",
        buildHide: "Dsl", buildCopy: "Dsl", buildMove: "Dsl", buildSend: "Dsl", buildExec: "Dsl",
        fetchLogEntry: "LogEntry",
        generateSessionName: "Envelope", generateRunName: "Envelope",
        createClientEnvelope: "Envelope", attachToSession: "Envelope", ensureClientLoop: "Envelope",
        listRunsForSession: "Envelope", closeClientLoop: "Envelope", listSessions: "Envelope",
        updateSessionProjectRoot: "Envelope", updateSessionPersona: "Envelope",
        attachYolo: "Yolo",
    };

    static async #walk(dir) {
        const out = [];
        for (const ent of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === ".tmp" || ent.name === "node_modules") continue;
                out.push(...(await ServerTopOoCodemod.#walk(full)));
            } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
        }
        return out;
    }

    static async run() {
        const roots = [join(ServerTopOoCodemod.#REPO, "src/server"), join(ServerTopOoCodemod.#REPO, "test")];
        const files = (await Promise.all(roots.map((r) => ServerTopOoCodemod.#walk(r)))).flat();
        const importRe = /^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";\s*$/;
        let patched = 0;

        for (const full of files) {
            const lines = (await readFile(full, "utf8")).split("\n");
            const byPath = new Map();
            const matched = [];
            const imported = new Set();

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith("import type")) continue;
                const m = line.match(importRe);
                if (!m || !ServerTopOoCodemod.#MODULE_RE.test(m[2])) continue;
                const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
                if (!names.some((n) => n in ServerTopOoCodemod.#MAP)) continue;
                if (!byPath.has(m[2])) byPath.set(m[2], { classes: new Set(), rest: new Set() });
                const b = byPath.get(m[2]);
                for (const n of names) {
                    if (n in ServerTopOoCodemod.#MAP) { b.classes.add(ServerTopOoCodemod.#MAP[n]); imported.add(n); }
                    else b.rest.add(n);
                }
                matched.push(i);
            }
            if (matched.length === 0) continue;

            const blocks = [];
            for (const [path, { classes, rest }] of byPath) {
                for (const c of [...classes].sort()) blocks.push(`import ${c} from "${path}";`);
                if (rest.size > 0) blocks.push(`import { ${[...rest].join(", ")} } from "${path}";`);
            }
            lines[matched[0]] = blocks.join("\n");
            for (let k = 1; k < matched.length; k++) lines[matched[k]] = " RM ";
            let out = lines.filter((l) => l !== " RM ").join("\n");

            for (const sym of [...imported].sort((a, b) => b.length - a.length)) {
                const re = new RegExp(`(?<!async )(?<![\\w.])${sym}\\b(?=\\()`, "g");
                out = out.replace(re, `${ServerTopOoCodemod.#MAP[sym]}.${sym}`);
            }
            await writeFile(full, out);
            patched++;
            console.log(`patched ${full.slice(ServerTopOoCodemod.#REPO.length + 1)}`);
        }
        console.log(`done: ${patched} files`);
    }
}

await ServerTopOoCodemod.run();
