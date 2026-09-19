// {§operator-config-env-defaults} — the cascading environment is the only home for a choice (#771).
//
// The platform is defined by three surfaces: `plurnk.md` (the language), turn 0 (the orientation)
// and the packages' `.env.defaults` (every choice). Code holds mechanism only. This gate counts
// every way a choice can find another home in shipped source, and refuses both new drift and a
// stale allowance, so the debt can only shrink. Done is an empty allowance file.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWANCE_PATH = join(ROOT, "scripts/env-surface-allowance.json");
const IGNORED_DIRECTORIES = new Set([".git", ".tmp", ".cache", "coverage", "dist", "node_modules"]);
const SOURCE_EXTENSIONS = /\.(?:ts|mjs|js|cjs)$/u;

// A reader that accepts a fallback can supply a value the panel never stated — and the one that
// existed also swallowed an invalid value silently. These are the standard's own defaults, not ours.
const STANDARD_FALLBACK = new Map([
    ["plurnk-core/src/core/HostPaths.ts", "the XDG base-directory specification defines these fallbacks"],
]);

// `PLURNK_*` strings that are not knobs. Each squats in the knob namespace and says why it may.
const NOT_A_KNOB = new Map([
    ["PLURNK_FENCE", "the language's fence, exported by contracts"],
    ["PLURNK_OPS", "the language's operation alphabet, exported by contracts"],
    ["PLURNK_X", "a documentation placeholder"],
    ["PLURNK_CONTEXT_UNKNOWN", "a provider diagnostic code"],
    ["PLURNK_FINISH_REASON_UNKNOWN", "a provider diagnostic code"],
    ["PLURNK_PROBE_FAILED", "a provider diagnostic code"],
    ["PLURNK_POOL_WINDOW_DRIFT", "a provider diagnostic code"],
    ["PLURNK_PROMPT_COUNT_ESTIMATE", "a provider diagnostic code"],
    ["PLURNK_VISIBLE_TOKEN_COUNT_UNAVAILABLE", "a provider diagnostic code"],
]);

// A key the code names only in order to refuse it. `shedRenamed(env, "OLD", …)` and a `retired`
// record are the two constructs that do so.
const RETIRED_CALL = /\bshedRenamed\(\s*[\w.]+\s*,\s*["'`](PLURNK_[A-Z0-9_]+)["'`]/gu;
const RETIRED_RECORD = /\bretired\b[^=\n]*=\s*\{([^}]*)\}/gu;

const isTest = (name) => /(?:^|\/)(?:test|tests|fixtures)\//u.test(name) || /\.test\.[^.]+$/u.test(name);
const isShipped = (name) => /^plurnk-[^/]+\/src\//u.test(name) && SOURCE_EXTENSIONS.test(name)
    && !isTest(name) && !/\.generated\./u.test(name);

// Comments carry history, not behaviour: a retired name mentioned in prose is not a read.
export const stripComments = (text) => {
    let out = "";
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];
        if (quote !== null) {
            out += char;
            if (char === "\\") { out += next ?? ""; i += 1; continue; }
            if (char === quote) quote = null;
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") { quote = char; out += char; continue; }
        if (char === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            out += "\n";
            continue;
        }
        if (char === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2);
            const stop = end === -1 ? text.length : end + 2;
            out += text.slice(i, stop).replace(/[^\n]/gu, " ");
            i = stop - 1;
            continue;
        }
        out += char;
    }
    return out;
};

export const readPanels = (panels) => {
    const live = new Map();
    const optional = new Map();
    const duplicates = [];
    for (const { name, content } of panels) {
        for (const line of content.split("\n")) {
            const bare = line.trim();
            const declared = /^(PLURNK_[A-Z0-9_]+)=/u.exec(bare);
            if (declared !== null) {
                const owner = live.get(declared[1]);
                if (owner !== undefined && owner !== name) duplicates.push(`${declared[1]}: declared by both ${owner} and ${name}`);
                live.set(declared[1], name);
                continue;
            }
            // {§exec-env-scoped}: a commented declaration is an optional knob, a declaration in its own right.
            const example = /^#\s*(PLURNK_[A-Z0-9_]+)=/u.exec(bare);
            if (example !== null && !optional.has(example[1])) optional.set(example[1], name);
        }
    }
    return { live, optional, duplicates };
};

// Every finding is `rule\tkey`, counted: the key is a file for a site count and a name for a name.
export const measure = ({ panels, sources, corpus }) => {
    const { live, optional, duplicates } = readPanels(panels);
    const declared = new Set([...live.keys(), ...optional.keys()]);
    const findings = new Map();
    const count = (rule, key, by = 1) => findings.set(`${rule}\t${key}`, (findings.get(`${rule}\t${key}`) ?? 0) + by);

    const retired = new Set();
    const families = new Set();
    const named = new Map();
    for (const { name, content } of sources) {
        if (!isShipped(name)) continue;
        const code = stripComments(content);
        for (const match of code.matchAll(RETIRED_CALL)) retired.add(match[1]);
        for (const match of code.matchAll(RETIRED_RECORD)) {
            for (const key of match[1].matchAll(/\b(PLURNK_[A-Z0-9_]+)\s*:/gu)) retired.add(key[1]);
        }
        // A computed name — `PLURNK_EXECS_${runtime}` — is a family, covered by one declared example.
        for (const match of code.matchAll(/["'`](PLURNK_[A-Z0-9_]*_)(?:\$\{|["'`]\s*\+)/gu)) families.add(match[1]);
        // A knob is named where it is read: a property, a bracket, or the exact string a reader is handed.
        // An exact string only: a message that merely begins with a key's name is prose.
        for (const match of code.matchAll(/\.(PLURNK_[A-Z0-9_]*[A-Z0-9])\b|["'`](PLURNK_[A-Z0-9_]*[A-Z0-9])["'`]/gu)) {
            const key = match[1] ?? match[2];
            if (!named.has(key)) named.set(key, name);
        }
        // A read that carries its own value is a default living in code.
        const fallbacks = [...code.matchAll(
            /(?:\.PLURNK_[A-Z0-9_]+|\[\s*["'`]PLURNK_[A-Z0-9_]+["'`]\s*\])\s*(?:\?\?|\|\|)\s*(?:["'`]|-?\d|true\b|false\b)/gu,
        )].length;
        if (fallbacks > 0) count("fallback", name, fallbacks);
        // By its own name, a default that lives in code.
        const constants = [...code.matchAll(/\b(?:const|let|static(?:\s+readonly)?)\s+#?DEFAULT_[A-Z0-9_]+\b/gu)].length;
        if (constants > 0) count("default-constant", name, constants);
        // Reading the system environment is the mechanism and is never a debt: node, the shell and
        // CI all speak it, and the floor is set-if-unset into it. What is a debt is a reader that
        // takes a fallback, because its signature lets a caller state a value the panel did not.
        if (!STANDARD_FALLBACK.has(name)) {
            const readers = [...code.matchAll(/\(([^()]*\b(?:fallback|defaultValue)\b[^()]*)\)\s*(?::[^=>{]+)?(?:=>|\{)([\s\S]{0,400})/gu)]
                .filter((match) => /\bprocess\.env\b|\benv\s*[.[]/u.test(match[2])).length;
            if (readers > 0) count("reader-fallback", name, readers);
        }
    }

    const covered = (name) => declared.has(name) || [...families].some((prefix) =>
        name.startsWith(prefix) && [...declared].some((key) => key.startsWith(prefix)));
    for (const [name] of named) {
        if (NOT_A_KNOB.has(name) || retired.has(name) || covered(name)) continue;
        count("undeclared", name);
    }
    for (const name of retired) if (declared.has(name)) count("retired-declared", name);
    for (const duplicate of duplicates) count("duplicate-owner", duplicate);

    // A live declaration nothing consumes means the panel lies. Tests and tooling count as consumers.
    const everything = corpus.map(({ content }) => content).join("\n");
    for (const name of live.keys()) {
        const referenced = new RegExp(`\\b${name}\\b`, "u").test(everything);
        const familyRead = [...families].some((prefix) => name.startsWith(prefix));
        if (!referenced && !familyRead) count("dead-knob", name);
    }
    return findings;
};

export const envSurfaceViolations = ({ panels, sources, corpus, allowance }) => {
    const findings = measure({ panels, sources, corpus });
    const violations = [];
    const allowed = new Map(Object.entries(allowance).flatMap(([rule, keys]) =>
        Object.entries(keys).map(([key, n]) => [`${rule}\t${key}`, n])));
    for (const [finding, actual] of findings) {
        const [rule, key] = finding.split("\t");
        const permitted = allowed.get(finding) ?? 0;
        if (actual > permitted) violations.push(`${rule}: ${key} — ${actual} found, allowance ${permitted}`);
    }
    // A debt that was paid must be struck from the allowance in the same change, or it can be re-borrowed.
    for (const [finding, permitted] of allowed) {
        const actual = findings.get(finding) ?? 0;
        if (actual < permitted) {
            const [rule, key] = finding.split("\t");
            violations.push(`${rule}: ${key} — allowance ${permitted} is stale, ${actual} remain; lower it`);
        }
    }
    return violations.toSorted();
};

export const allowanceOf = (findings) => {
    const out = {};
    for (const [finding, n] of [...findings].toSorted(([a], [b]) => a.localeCompare(b))) {
        const [rule, key] = finding.split("\t");
        (out[rule] ??= {})[key] = n;
    }
    return out;
};

const filesUnder = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        if (IGNORED_DIRECTORIES.has(entry.name)) return [];
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    }));
    return nested.flat();
};

const load = async () => {
    const paths = await filesUnder(ROOT);
    const read = async (path) => ({ name: relative(ROOT, path), content: await readFile(path, "utf8") });
    const panels = await Promise.all(paths.filter((path) => path.endsWith("/.env.defaults")).map(read));
    const corpus = await Promise.all(paths.filter((path) => SOURCE_EXTENSIONS.test(path) || path.endsWith(".sh")).map(read));
    return { panels, sources: corpus, corpus };
};

if (import.meta.main) {
    const input = await load();
    if (process.argv.includes("--write")) {
        const findings = measure(input);
        await writeFile(ALLOWANCE_PATH, `${JSON.stringify(allowanceOf(findings), null, 4)}\n`);
    }
    const allowance = JSON.parse(await readFile(ALLOWANCE_PATH, "utf8"));
    const violations = envSurfaceViolations({ ...input, allowance });
    if (violations.length > 0) {
        console.error(`Environment surface policy violations:\n${violations.map((violation) => `  ${violation}`).join("\n")}`);
        process.exit(1);
    }
    const debt = Object.entries(allowance).map(([rule, keys]) =>
        `${rule} ${Object.values(keys).reduce((sum, n) => sum + n, 0)}`);
    console.log(`env surface OK${debt.length === 0 ? "" : ` — remaining debt: ${debt.join(", ")}`}`);
}
