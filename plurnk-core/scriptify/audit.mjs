// Repo-wide directive-alignment scan. Reads via node:fs (immune to the
// §-grep binary gotcha). Covers the MECHANICALLY-detectable directives and
// the WHOLE tree; explicitly lists the architectural tier it CANNOT check,
// so "comprehensive" never silently means "the parts a regex can see."
// Run: node scriptify/audit.mjs

import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";

export default class DirectiveAudit {
    static #REPO = join(import.meta.dirname, "..");
    static #SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".tmp"]);
    static #BUILTINS = new Set([
        "fs", "fs/promises", "path", "crypto", "os", "util", "events", "stream",
        "stream/promises", "http", "https", "net", "url", "child_process", "assert",
        "assert/strict", "buffer", "querystring", "zlib", "readline", "tls", "dns",
        "timers", "timers/promises", "worker_threads", "perf_hooks", "vm",
        "string_decoder", "module", "sqlite", "test", "process",
    ]);
    static #BANNED = [
        "axios", "node-fetch", "dotenv", "yargs", "commander", "jest", "mocha",
        "chai", "nodemon", "zod", "effect", "ts-pattern", "ts-node", "lodash",
    ];

    static #rel(f) { return relative(DirectiveAudit.#REPO, f); }

    static async #walk(dir) {
        const out = [];
        for (const ent of await readdir(dir, { withFileTypes: true })) {
            if (ent.isDirectory()) {
                if (DirectiveAudit.#SKIP_DIRS.has(ent.name)) continue;
                out.push(...(await DirectiveAudit.#walk(join(dir, ent.name))));
            } else out.push(join(dir, ent.name));
        }
        return out;
    }

    static #classifyModule(c) {
        if (/^export default class\b/m.test(c)) return "class";
        const arrow = /^export const \w+[^=\n]*=\s*(async\s+)?\(/m.test(c)
            || /^export const \w+\s*=\s*(async\s+)?[\w$]+\s*=>/m.test(c);
        const fn = /^export (async )?function\b/m.test(c) || /^export default (?!class\b)(async\s+)?function\b/m.test(c);
        const value = /^export (const|function|async function)\b/m.test(c) || /^export default (?!class\b)/m.test(c);
        if (arrow || fn) return "function-module";
        if (value) return "data";
        return "type-or-barrel";
    }

    static #section(title, arr) {
        console.log(`\n## ${title} (${arr.length})`);
        for (const x of arr.slice(0, 60)) console.log(`  ${x}`);
        if (arr.length > 60) console.log(`  … +${arr.length - 60} more`);
    }

    static async run() {
        const files = await DirectiveAudit.#walk(DirectiveAudit.#REPO);
        const area = (f) => { const p = DirectiveAudit.#rel(f).split("/"); return p.length > 1 ? p[0] : "(root)"; };

        const inv = {};
        for (const f of files) {
            const a = area(f); const e = extname(f) || "(none)";
            (inv[a] ??= {})[e] = ((inv[a] ??= {})[e] ?? 0) + 1;
        }
        console.log("=== FILE INVENTORY (area → ext → count) ===");
        for (const a of Object.keys(inv).sort()) {
            const exts = Object.entries(inv[a]).map(([e, n]) => `${e}:${n}`).join("  ");
            console.log(`  ${a.padEnd(14)} ${exts}`);
        }

        const code = files.filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts"));
        const srcMods = code.filter((f) => DirectiveAudit.#rel(f).startsWith("src/") && !/\.test\.(ts|js)$/.test(f));

        const jsInSrcBin = code.filter((f) => /\.(js|mjs)$/.test(f) && /^(src|bin)\//.test(DirectiveAudit.#rel(f)));
        const ooViol = [];
        for (const f of srcMods) {
            if (DirectiveAudit.#classifyModule(await readFile(f, "utf8")) === "function-module") ooViol.push(DirectiveAudit.#rel(f));
        }

        const cjs = [], vars = [], badBuiltin = [], banned = [], inlineSql = [], fallbacks = [];
        const importRe = /(?:from|import)\s+["']([^"']+)["']/g;
        const sqlRe = /`[^`]*\b(SELECT\b[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*?\bSET|CREATE\s+TABLE|DELETE\s+FROM)\b/i;
        const fbRe = /(\|\||\?\?)\s*(""|''|\[\]|\{\}|0|null)/g;
        for (const f of code) {
            const c = await readFile(f, "utf8");
            const r = DirectiveAudit.#rel(f);
            if (/\brequire\s*\(/.test(c) || /\bmodule\.exports\b/.test(c) || /^\s*exports\./m.test(c)) cjs.push(r);
            if (/^\s*var\s+[A-Za-z_$]/m.test(c)) vars.push(r);
            for (const m of c.matchAll(importRe)) {
                const mod = m[1];
                if (!mod.startsWith("node:") && DirectiveAudit.#BUILTINS.has(mod)) badBuiltin.push(`${r} -> "${mod}"`);
                const base = mod.replace(/^@[^/]+\//, "").split("/")[0];
                if (DirectiveAudit.#BANNED.includes(mod) || DirectiveAudit.#BANNED.includes(base)) banned.push(`${r} -> "${mod}"`);
            }
            if (sqlRe.test(c)) inlineSql.push(r);
            const fb = (c.match(fbRe) ?? []).length;
            if (fb > 0) fallbacks.push(`${r} (${fb})`);
        }

        const pkgBanned = [], loosePins = [];
        try {
            const pkg = JSON.parse(await readFile(join(DirectiveAudit.#REPO, "package.json"), "utf8"));
            for (const sect of ["dependencies", "devDependencies", "peerDependencies"]) {
                for (const [k, v] of Object.entries(pkg[sect] ?? {})) {
                    if (DirectiveAudit.#BANNED.includes(k)) pkgBanned.push(`${sect}: ${k}@${v}`);
                    if (k.startsWith("@plurnk/") && /[\^~><*x]/.test(v)) loosePins.push(`${k}@${v}`);
                }
            }
        } catch (err) { console.log(`\n(package.json read failed: ${err.message})`); }

        console.log("\n=== MECHANICAL CHECKS ===");
        DirectiveAudit.#section("OO: function-modules → should be `export default class` (src non-test)", ooViol);
        DirectiveAudit.#section("Toolchain: .js/.mjs in src|bin → should be native .ts", jsInSrcBin.map(DirectiveAudit.#rel));
        DirectiveAudit.#section("Banned libraries in imports", banned);
        DirectiveAudit.#section("Banned libraries in package.json", pkgBanned);
        DirectiveAudit.#section("Non-exact @plurnk/* pins (package.json)", loosePins);
        DirectiveAudit.#section("CJS (require / module.exports / exports.)", cjs);
        DirectiveAudit.#section("var declarations", vars);
        DirectiveAudit.#section("builtin imports missing node: prefix", badBuiltin);
        DirectiveAudit.#section("Possible inline SQL in .ts/.js (review — SQL belongs in .sql)", inlineSql);
        DirectiveAudit.#section("Fallback/defensive patterns `||`/`??` + 0/\"\"/[]/{}/null (REVIEW — false positives expected)", fallbacks);

        console.log("\n=== NOT MECHANICALLY CHECKED — REQUIRES MANUAL READ-AND-REASON ===");
        for (const x of [
            "Fail-hard / no log-and-continue / surface root cause (semantic, not pattern)",
            "Defensive-coding judgment beyond the literal `||`/`??` patterns above",
            "`#private` fields for ALL internal class state (needs per-class read)",
            "Object.freeze on config/constant structures",
            "Error.cause on every wrap/re-throw",
            "AbortController/AbortSignal on cancellable async",
            "Map/Set for dynamic collections vs plain objects",
            "Locality of behavior/error; minimalism (no just-in-case)",
            "Schemas-are-source-of-truth; DB-is-the-application; no inline SQL (semantic)",
            "i18n: no bare english strings in core (only tags)",
            "let→const, no else-after-return, optional-chaining/nullish (AST-grade style)",
            "Test discipline: seedRun helper, specific assertions, real .db, terminal-set",
            "Coverage 50/50/50 (run with --experimental-test-coverage)",
        ]) console.log(`  - ${x}`);
    }
}

await DirectiveAudit.run();
