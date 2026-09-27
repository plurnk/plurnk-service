// #887 — which exports of the integration harness each suite actually uses, so a helper change is
// read against the suites it can redden. A measurement, never a gate: `node scripts/harness-usage.mjs [--suites]` from plurnk-core.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: { suites: showSuites } } = parseArgs({ options: { suites: { type: "boolean", default: false } } });
const dir = resolve(import.meta.dirname, "../test/intg");
const harness = ["_db.ts", "_scheme.ts", "_execs.ts", "_packet.ts", "_provider.ts", "_rpc.ts", "_mock.ts", "_dsl.ts", "_seam.ts", "_find.ts", "_entry-scheme.ts", "_stream-mock.ts", "_a2a.ts", "_launcher.ts", "_observe-memory.ts"];
const suites = readdirSync(dir).filter((name) => name.endsWith(".test.ts")).toSorted();

// suite → module → Set of imported names ("*" for a namespace or default import).
const usage = new Map();
for (const suite of suites) {
    const source = readFileSync(resolve(dir, suite), "utf8");
    for (const [, clause, module] of source.matchAll(/^import\s+(?:type\s+)?([^;]*?)\s+from\s+["']\.\/([^"']+)["'];?$/gmu)) {
        if (!harness.includes(module)) continue;
        const names = clause.startsWith("{")
            ? clause.slice(1, -1).split(",").map((name) => name.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]).filter(Boolean)
            : ["*"];
        const modules = usage.get(suite) ?? new Map();
        modules.set(module, new Set([...(modules.get(module) ?? []), ...names]));
        usage.set(suite, modules);
    }
}

const fanOut = (module) => suites.filter((suite) => usage.get(suite)?.has(module)).length;
console.log(`${suites.length} suites; harness fan-out:`);
for (const module of harness) { const n = fanOut(module); if (n > 0) console.log(`  ${module.padEnd(18)} ${String(n).padStart(4)} suites`); }

for (const module of harness.slice(0, 7)) {
    const byExport = new Map();
    for (const suite of suites) for (const name of usage.get(suite)?.get(module) ?? []) byExport.set(name, [...(byExport.get(name) ?? []), suite]);
    console.log(`\n${module}: ${byExport.size} exports in use`);
    for (const [name, users] of [...byExport].toSorted((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${name.padEnd(30)} ${String(users.length).padStart(4)}${showSuites ? `  ${users.slice(0, 6).join(" ")}${users.length > 6 ? " …" : ""}` : ""}`);
    }
    // Co-usage: how often each pair of exports is imported by the same suite, for the split.
    const names = [...byExport.keys()];
    const together = (a, b) => byExport.get(a).filter((suite) => byExport.get(b).includes(suite)).length;
    const pairs = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b, together(a, b)])).filter(([, , n]) => n >= 5).toSorted((x, y) => y[2] - x[2]);
    console.log(`  strongest co-use (≥5 suites): ${pairs.slice(0, 12).map(([a, b, n]) => `${a}+${b}=${n}`).join(", ")}`);
}
