// Resident-memory probe for the tree-sitter path ({§mimetype-lifecycle}): parses generated
// sources through the production framework and attributes RSS by /proc/self/smaps mapping,
// so the WASM linear memory (one anonymous mapping that only grows) is told apart from V8 heap
// pages the memory reducer returns on idle. Report only, never a gate: absolute RSS is host-bound.
//   npm run memory:probe            (TARGET_BYTES, DISCOVER_CWD override the defaults)
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import v8 from "node:v8";
import Mimetypes from "../src/Mimetypes.ts";

if (typeof gc !== "function") throw new Error("run with --expose-gc");

const TARGET = Number(process.env.TARGET_BYTES ?? 1_700_000);
const cwd = process.env.DISCOVER_CWD ?? path.resolve(import.meta.dirname, "../../plurnk-core");
const MiB = (bytes) => +(bytes / 1048576).toFixed(1);
const kib = (n) => (n / 1024).toFixed(1);

function snapshot() {
    const maps = new Map();
    let cur = null;
    let key = "";
    for (const line of readFileSync("/proc/self/smaps", "utf8").split("\n")) {
        const head = /^([0-9a-f]+-[0-9a-f]+) \S+ \S+ \S+ \S+\s*(.*)$/.exec(line);
        if (head) {
            if (cur) maps.set(key, cur);
            key = head[1];
            cur = { size: 0, rss: 0, name: head[2] };
            continue;
        }
        if (!cur) continue;
        if (line.startsWith("Size:")) cur.size = parseInt(line.slice(5), 10);
        else if (line.startsWith("Rss:")) cur.rss = parseInt(line.slice(4), 10);
    }
    if (cur) maps.set(key, cur);
    return maps;
}

// The wasm linear memory is the largest anonymous mapping; V8 heap pages are many small ones;
// glibc's brk heap is [heap]; the rest is file-backed.
function classes(maps) {
    let heap = 0;
    let files = 0;
    let small = 0;
    const anon = [];
    for (const m of maps.values()) {
        if (m.name === "[heap]") heap += m.rss;
        else if (m.name.startsWith("/")) files += m.rss;
        else if (m.rss >= 8 * 1024) anon.push(m);
        else small += m.rss;
    }
    anon.sort((x, y) => y.rss - x.rss);
    return `anon≥8MiB [${anon.map((m) => `${kib(m.rss)}/${kib(m.size)}`).join(", ")}] · anon<8MiB ${kib(small)} · [heap] ${kib(heap)} · files ${kib(files)}`;
}

const rows = [];
async function stage(label, fn) {
    const t0 = performance.now();
    await fn();
    const ms = Math.round(performance.now() - t0);
    gc(); await sleep(30); gc(); await sleep(30);
    const mu = process.memoryUsage();
    const hs = v8.getHeapStatistics();
    const row = { stage: `${label} (${ms} ms)`, rss: MiB(mu.rss), heapUsed: MiB(mu.heapUsed), v8Physical: MiB(hs.total_physical_size), external: MiB(mu.external), classes: classes(snapshot()) };
    rows.push(row);
    console.log(JSON.stringify(row));
}

const generators = {
    typescript: { mimetype: "text/typescript", path: "big.ts", line: (i) => `export function fn${i}(value: number): number { const result = value + ${i}; return result; }\n` },
    python: { mimetype: "text/x-python", path: "big.py", line: (i) => `def fn${i}(value: int) -> int:\n    result = value + ${i}\n    return result\n\n` },
    go: { mimetype: "text/x-go", path: "big.go", head: "package main\n\n", line: (i) => `func fn${i}(value int) int {\n\tresult := value + ${i}\n\treturn result\n}\n\n` },
    rust: { mimetype: "text/x-rust", path: "big.rs", line: (i) => `pub fn fn${i}(value: i64) -> i64 {\n    let result = value + ${i};\n    result\n}\n\n` },
};
const languages = Object.keys(generators);

function source(lang, bytes = TARGET) {
    const g = generators[lang];
    const parts = [g.head ?? ""];
    let total = parts[0].length;
    for (let i = 0; total < bytes; i += 1) { const l = g.line(i); parts.push(l); total += l.length; }
    return parts.join("");
}

const mimetypes = new Mimetypes({ discoverOptions: { cwd } });
await stage("framework ready", () => mimetypes.ready());
for (const lang of languages) {
    if (await mimetypes.getHandler(generators[lang].mimetype) === null) throw new Error(`no handler for ${generators[lang].mimetype} from ${cwd}`);
}
const small = (lang) => source(lang, 200);
const derive = (m, lang, content) => m.process(
    { content, hint: generators[lang].mimetype, path: generators[lang].path },
    { channels: ["symbols", "references"], summary: true, parseIssues: true },
);
const issuesOnly = async (lang, content) => (await mimetypes.getHandler(generators[lang].mimetype)).parseIssues(content);
const big = Object.fromEntries(languages.map((l) => [l, source(l)]));
console.log(JSON.stringify({ node: process.version, cwd, sources: Object.fromEntries(languages.map((l) => [l, `${MiB(big[l].length)} MiB`])) }));

await stage("typescript warm (small parseIssues)", () => issuesOnly("typescript", small("typescript")));
await stage("typescript large parseIssues #1", () => issuesOnly("typescript", big.typescript));
await stage("typescript large parseIssues #2", () => issuesOnly("typescript", big.typescript));
await stage("typescript large derive (symbols+references+parseIssues) #1", () => derive(mimetypes, "typescript", big.typescript));
await stage("typescript large derive #2", () => derive(mimetypes, "typescript", big.typescript));
for (const lang of ["python", "go", "rust"]) {
    await stage(`${lang} warm (small derive)`, () => derive(mimetypes, lang, small(lang)));
    await stage(`${lang} large derive`, () => derive(mimetypes, lang, big[lang]));
}
await stage("four large derives, sequential", async () => { for (const lang of languages) await derive(mimetypes, lang, big[lang]); });
await stage("four large derives, concurrent", () => Promise.all(languages.map((lang) => derive(mimetypes, lang, big[lang]))));
await stage("idle 8 s", () => sleep(8000));
await stage("four large parseIssues, concurrent", () => Promise.all(languages.map((lang) => issuesOnly(lang, big[lang]))));
await stage("typescript large derive ×4 concurrent, one handler", () => Promise.all([0, 1, 2, 3].map(() => derive(mimetypes, "typescript", big.typescript))));
await stage("release sources", async () => { for (const k of languages) big[k] = ""; });
await stage("dispose()", () => mimetypes.dispose());
const second = new Mimetypes({ discoverOptions: { cwd } });
await stage("second instance: ready + typescript large derive", async () => { await second.ready(); await derive(second, "typescript", source("typescript")); });
await stage("second instance: dispose()", () => second.dispose());
await stage("idle 8 s (retained floor)", () => sleep(8000));

console.log("\n| Stage | RSS MiB | JS heap used | V8 physical | external | Mapping classes (rss/size MiB) |");
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
for (const r of rows) console.log(`| ${r.stage} | ${r.rss} | ${r.heapUsed} | ${r.v8Physical} | ${r.external} | ${r.classes} |`);
