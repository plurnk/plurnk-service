// {§operator-config-env-defaults} — the cascading environment is the only home for a choice (#771).
//
// The platform is defined by three surfaces: `plurnk.md` (the language), turn 0 (the orientation)
// and the packages' `.env.defaults` (every choice). Code holds mechanism only. This gate counts
// every way a choice can find another home in shipped source, and refuses both new drift and a
// stale allowance, so the debt can only shrink. Done is an empty allowance file.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWANCE_PATH = join(ROOT, "scripts/env-surface-allowance.json");
const MECHANISM_PATH = join(ROOT, "scripts/env-surface-mechanism.json");
const SOURCE_EXTENSIONS = /\.(?:ts|mjs|js|cjs)$/u;

// A number whose own name says duration, size, count or pacing is a choice by that name, exactly as
// `DEFAULT_` is: it moves to the panel, or the register of mechanism says why it may stay. The
// register is reviewed, permanent and small — the deliberate "this is not a knob, because…" list
// that keeps the panel free of knobs nobody would turn.
const CONFESSING = /(?:^|_)(?:MS|SEC|SECONDS|MINUTES|TIMEOUT|DEADLINE|INTERVAL|TTL|GRACE|DELAY|BACKOFF|RETRY|RETRIES|ATTEMPTS|ROUNDS|LIMIT|MAX|MAXIMUM|MIN|MINIMUM|FLOOR|CEILING|CAP|BYTES|SIZE|LINES|CHARS|CODEPOINTS|POINTS|ITEMS|SAMPLE|SAMPLES|PREVIEW|WIDTH|DEPTH|PASSES|FRACTION|MARGIN|TOKENS|PATHS|CONCURRENCY|WINDOW|PAGE)(?:_|$)/u;
const NUMERIC_CONSTANT = /\b(?:const|static(?:\s+readonly)?)\s+#?([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*-?(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?)n?(?:\s*\*\s*\d[\d_]*)*\s*;/gu;
// A read and the value it carries, seen through the normalising calls a read applies first
// (`env.PLURNK_X?.trim() ?? "…"`). A bare property is a question ABOUT the value, not the value.
const FALLBACK = /(?:\.(PLURNK_[A-Z0-9_]+)|\[\s*["'`](PLURNK_[A-Z0-9_]+)["'`]\s*\])(?:\??\.[A-Za-z_$][\w$]*\s*\([^()\n]*\))*\s*(?:\?\?|\|\|)\s*(""|''|``|["'`][^"'`\n]*["'`]|-?\d[\d_]*|true\b|false\b)/gu;

// A bare number handed to a timer or a deadline has no name to confess with, so it has no register:
// it is named, or it is read from the panel.
const TIMER_LITERAL = /\b(?:setTimeout|setInterval|delay|sleep|AbortSignal\.timeout)\s*\([^()\n]*?\b\d[\d_]+\s*[,)]/gu;

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

// A key the code names only in order to refuse it. The house says "shed": `shedRenamed(env, "OLD",
// …)` retires its first name, and a function named `shed…` retires every key it spells out.
const RETIRED_CALL = /\bshedRenamed\(\s*[\w.]+\s*,\s*["'`](PLURNK_[A-Z0-9_]+)["'`]/gu;
const RETIRED_RECORD = /\bretired\b[^=\n]*=\s*\{([^}]*)\}/gu;
const RETIRING_FUNCTION = /#?\bshed[A-Z]\w*\s*(?:=\s*)?\([^)]*\)[^{;]*\{([\s\S]{0,1600}?)\n\}/gu;

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
export const measure = ({ panels, sources, corpus, manifests = [] }) => {
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
        for (const match of code.matchAll(RETIRING_FUNCTION)) {
            if (/^\s*shedRenamed\b/u.test(match[0])) continue;
            for (const key of match[1].matchAll(/["'`](PLURNK_[A-Z0-9_]*[A-Z0-9])["'`]/gu)) retired.add(key[1]);
        }
        // A computed name — `PLURNK_EXECS_${runtime}` — is a family, covered by one declared example.
        for (const match of code.matchAll(/["'`](PLURNK_[A-Z0-9_]*_)(?:\$\{|["'`]\s*\+)/gu)) families.add(match[1]);
        // A knob is named where it is read: a property, a bracket, or the exact string a reader is handed.
        // An exact string only: a message that merely begins with a key's name is prose.
        for (const match of code.matchAll(/\.(PLURNK_[A-Z0-9_]*[A-Z0-9])\b|["'`](PLURNK_[A-Z0-9_]*[A-Z0-9])["'`]/gu)) {
            const key = match[1] ?? match[2];
            if (!named.has(key)) named.set(key, name);
        }
        // A read that carries its own value is a default living in code — including through an
        // accessor (`env.PLURNK_X?.trim() ?? …`), and including an empty one when the panel states a
        // live value, because then the code and the panel disagree about what unset means. An
        // OPTIONAL key's empty fallback is its absence, which is the law: unset means off.
        for (const match of code.matchAll(FALLBACK)) {
            const key = match[1] ?? match[2];
            const value = match[3];
            if (/^(?:""|''|``)$/u.test(value) && !live.has(key)) continue;
            count("fallback", name);
        }
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
        for (const match of code.matchAll(NUMERIC_CONSTANT)) {
            if (CONFESSING.test(match[1])) count("tunable", `${name}:${match[1]}`);
        }
        const timers = [...code.matchAll(TIMER_LITERAL)].length;
        if (timers > 0) count("timer-literal", name, timers);
    }

    const covered = (name) => declared.has(name) || [...families].some((prefix) =>
        name.startsWith(prefix) && [...declared].some((key) => key.startsWith(prefix)));
    for (const [name] of named) {
        if (NOT_A_KNOB.has(name) || retired.has(name) || covered(name)) continue;
        count("undeclared", name);
    }
    for (const name of retired) if (declared.has(name)) count("retired-declared", name);

    // "The floor is always assembled" has to be true where the code is exercised, or a strict read
    // is impossible and a fallback creeps back in: a package that ships a panel tests on it.
    const panelOwners = new Set(panels.map(({ name }) => name.replace(/\/?\.env\.defaults$/u, "")));
    for (const { name, content } of manifests) {
        const owner = name.replace(/\/?package\.json$/u, "");
        if (!panelOwners.has(owner)) continue;
        const scripts = JSON.parse(content).scripts ?? {};
        for (const script of ["test:unit", "test:intg"]) {
            const command = scripts[script];
            if (typeof command !== "string" || !/\bnode\b/u.test(command)) continue;
            if (!/--env-file(?:-if-exists)?=(?:\.\/)?\.env\.defaults\b/u.test(command)) count("test-floor", `${owner} ${script}`);
        }
    }
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

export const envSurfaceViolations = ({ panels, sources, corpus, manifests, allowance, mechanism = {} }) => {
    const findings = measure({ panels, sources, corpus, manifests });
    const violations = [];
    const allowed = new Map(Object.entries(allowance).flatMap(([rule, keys]) =>
        Object.entries(keys).map(([key, n]) => [`${rule}\t${key}`, n])));
    // The register answers `tunable` findings one by one, each with its reason; it is not a debt.
    for (const [key, reason] of Object.entries(mechanism)) {
        if (typeof reason !== "string" || reason.trim().length === 0) violations.push(`tunable: ${key} — the register gives no reason`);
        if (!findings.has(`tunable\t${key}`)) violations.push(`tunable: ${key} — registered as mechanism but gone; strike it from the register`);
    }
    for (const [finding, actual] of findings) {
        const [rule, key] = finding.split("\t");
        if (rule === "tunable") {
            if (!Object.hasOwn(mechanism, key)) violations.push(`tunable: ${key} — its name says duration, size or limit: move it to the panel, or register why it is mechanism`);
            continue;
        }
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
        if (rule === "tunable") continue;
        (out[rule] ??= {})[key] = n;
    }
    return out;
};

// Source is what Git tracks or would track: build output and ignored scratch are not the platform.
const load = async () => {
    const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 1 << 26 });
    const names = stdout.split("\0").filter((name) => name.length > 0);
    const read = async (name) => ({ name, content: await readFile(join(ROOT, name), "utf8").catch(() => null) });
    const present = async (selected) => (await Promise.all(selected.map(read))).filter(({ content }) => content !== null);
    const panels = await present(names.filter((name) => name.endsWith("/.env.defaults")));
    const corpus = await present(names.filter((name) => SOURCE_EXTENSIONS.test(name) || name.endsWith(".sh")));
    const manifests = await present(names.filter((name) => /^plurnk-[^/]+\/package\.json$/u.test(name)));
    return { panels, sources: corpus, corpus, manifests };
};

if (import.meta.main) {
    const input = await load();
    if (process.argv.includes("--write")) {
        const findings = measure(input);
        await writeFile(ALLOWANCE_PATH, `${JSON.stringify(allowanceOf(findings), null, 4)}\n`);
    }
    const allowance = JSON.parse(await readFile(ALLOWANCE_PATH, "utf8"));
    const mechanism = JSON.parse(await readFile(MECHANISM_PATH, "utf8"));
    const violations = envSurfaceViolations({ ...input, allowance, mechanism });
    if (violations.length > 0) {
        console.error(`Environment surface policy violations:\n${violations.map((violation) => `  ${violation}`).join("\n")}`);
        process.exit(1);
    }
    const debt = Object.entries(allowance).map(([rule, keys]) =>
        `${rule} ${Object.values(keys).reduce((sum, n) => sum + n, 0)}`);
    console.log(`env surface OK${debt.length === 0 ? "" : ` — remaining debt: ${debt.join(", ")}`} — ${Object.keys(mechanism).length} numbers registered as mechanism`);
}
