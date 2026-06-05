// Axis 2: rewrite callers of the former packet-wire.js free functions onto
// the new PacketWire class (and the .js→.ts path). Guards: the call-site rule
// excludes `#` (Engine's #packetToWireMessages private method collides with the
// function name), and a per-file class-emitted flag dedupes (packet-wire.test
// imports from the module twice). Verified by tsc + the test run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class PacketWireCodemod {
    static #REPO = join(import.meta.dirname, "..");
    static #MODULE_RE = /packet-wire\.(js|ts)$/;
    static #MAP = {
        renderSystemContent: "PacketWire", renderUserContent: "PacketWire",
        packetToWireMessages: "PacketWire", measureBudgetSections: "PacketWire",
    };

    static async #walk(dir) {
        const out = [];
        for (const ent of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === ".tmp" || ent.name === "node_modules" || ent.name === ".git") continue;
                out.push(...(await PacketWireCodemod.#walk(full)));
            } else if (/\.(ts|js|mjs)$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
        }
        return out;
    }

    static async run() {
        const roots = ["src", "bin", "test"].map((r) => join(PacketWireCodemod.#REPO, r));
        const files = (await Promise.all(roots.map((r) => PacketWireCodemod.#walk(r)))).flat();
        const importRe = /import\s+\{([^}]*)\}\s+from\s+"([^"]+)";/g;

        for (const full of files) {
            let text = await readFile(full, "utf8");
            const imported = new Set();
            let classEmitted = false;
            text = text.replace(importRe, (m, names, path) => {
                if (!PacketWireCodemod.#MODULE_RE.test(path)) return m;
                const syms = names.split(",").map((s) => s.trim()).filter(Boolean);
                const mapped = syms.filter((s) => s in PacketWireCodemod.#MAP);
                if (mapped.length === 0) return m;
                for (const s of mapped) imported.add(s);
                const rest = syms.filter((s) => !(s in PacketWireCodemod.#MAP));
                const newPath = path.replace(/packet-wire\.js$/, "packet-wire.ts");
                const parts = [];
                if (!classEmitted) { parts.push(`import PacketWire from "${newPath}";`); classEmitted = true; }
                if (rest.length > 0) parts.push(`import { ${rest.join(", ")} } from "${newPath}";`);
                return parts.join("\n");
            });
            if (imported.size === 0) continue;

            for (const sym of [...imported].sort((a, b) => b.length - a.length)) {
                const re = new RegExp(`(?<!async )(?<![\\w.#])${sym}\\b(?=\\()`, "g");
                text = text.replace(re, `PacketWire.${sym}`);
            }
            await writeFile(full, text);
            console.log(`patched ${full.slice(PacketWireCodemod.#REPO.length + 1)}`);
        }
    }
}

await PacketWireCodemod.run();
