#!/usr/bin/env node
// Deterministic dependency and grammar-pin health checks across the @plurnk/plurnk-mimetypes
// universe and sibling @plurnk repositories ({§release-candidate-graph}, {§mimetype-grammar-packages}).
//
//   1. PINS      — exact pins (first-party @plurnk/* and third-party exact pins such as
//                  tree-sitter-cli in the grammar packages) that trail npm-latest.
//   2. EXTERNAL  — third-party simple caret/tilde ranges (^x.y.z / ~x.y.z) whose ceiling
//                  now trails npm-latest.
//   3. LOCKFILES — direct dependencies/devDependencies in standalone repositories whose
//                  committed package-lock.json version trails npm-latest.
//   4. PEERS     — extension peer ranges on @plurnk/plurnk-mimetypes vs the core tip.
//   5. GRAMMARS  — upstream .grammar-pin commits across all 28 @plurnk/plurnk-mimetypes-grammar-*
//                  packages vs upstream stable release tags.
//   6. AUDIT     — `npm audit` per mimetypes package that carries third-party runtime deps.
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usage } from "../../scripts/lib/usage.mjs";
import { runGrammarLifecycle } from "./update-grammars.mjs";

usage(import.meta, `
usage: npm run deps:check [-- --only pins|audit]   (from plurnk-mimetypes)
Checks exact pins, external ranges, committed lockfiles, peer ranges, upstream grammar pins, and npm audit across the mimetypes package family ({§release-candidate-graph}, {§mimetype-grammar-packages}).
Reads: PLURNK_MIMETYPES_PACKAGES_ROOT, PLURNK_MIMETYPES_AUDIT_LEVEL, package manifests, lockfiles, and npm registry metadata.
Writes: findings to stdout; exit 1 on any issue.
`);

try { process.loadEnvFile(); } catch { /* no .env — fine */ }
if (process.env.PLURNK_MIMETYPES_FAMILY_ROOT !== undefined) throw new Error("PLURNK_MIMETYPES_FAMILY_ROOT is retired: set PLURNK_MIMETYPES_PACKAGES_ROOT."); // lexicon-allow: the retired setting's shed

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const runPins = !only || only === "pins";
const runAudit = !only || only === "audit";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const auditLevel = process.env.PLURNK_MIMETYPES_AUDIT_LEVEL || "moderate";
if (!SEVERITIES.includes(auditLevel)) throw new Error(`Invalid PLURNK_MIMETYPES_AUDIT_LEVEL "${auditLevel}" — expected one of ${SEVERITIES.join("|")}`);
const levelIdx = SEVERITIES.indexOf(auditLevel);

const here = path.dirname(fileURLToPath(import.meta.url));
const frameworkRoot = path.resolve(here, "..");
const monorepoRoot = path.resolve(frameworkRoot, "..");
const root = process.env.PLURNK_MIMETYPES_PACKAGES_ROOT
    ? path.resolve(process.env.PLURNK_MIMETYPES_PACKAGES_ROOT)
    : path.resolve(monorepoRoot, "..");

const waiversPath = path.join(monorepoRoot, "deps-waivers.json");
const waivers = existsSync(waiversPath)
    ? (JSON.parse(readFileSync(waiversPath, "utf8")).waivers ?? {})
    : {};
const isWaived = (name) => {
    const w = waivers[name];
    return Boolean(w && w.ownerVeto === true && w.reason && /^https?:\/\/.+\/issues\/\d+$/.test(w.issue ?? "") && w.lane);
};

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Discover every @plurnk/plurnk-mimetypes* package (both in-monorepo workspaces and
// standalone sibling repositories) plus sibling open-source @plurnk repositories.
const pkgs = [];
const seenDirs = new Set();
const scanDir = (baseDir, includeAllSiblingPlurnk = false) => {
    if (!existsSync(baseDir)) return;
    for (const name of readdirSync(baseDir).toSorted()) {
        const dir = path.join(baseDir, name);
        if (seenDirs.has(dir)) continue;
        const pjPath = path.join(dir, "package.json");
        if (!existsSync(pjPath) || !statSync(dir).isDirectory()) continue;
        try {
            const pj = JSON.parse(readFileSync(pjPath, "utf-8"));
            const isMimetype = pj.name?.includes("plurnk-mimetypes");
            const isSiblingPlurnk = includeAllSiblingPlurnk && (name === "plurnk" || name === "plurnk-schemes-http-tavily");
            if (isMimetype || isSiblingPlurnk) {
                seenDirs.add(dir);
                pkgs.push({ dir, slug: name, pj, isMimetype: Boolean(isMimetype), standalone: baseDir === root });
            }
        } catch (e) { console.error(`  parse fail ${name}: ${e.message}`); }
    }
};
scanDir(monorepoRoot, false);
scanDir(root, true);

const triplet = (v) => v.replace(/^[\^~>=<\s]+/, "").split("-")[0].split(".").map(Number);
const cmp = (a, b) => { const [A, B] = [triplet(a), triplet(b)]; for (let i = 0; i < 3; i += 1) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); } return 0; };
const isExact = (range) => /^\d/.test(range);

const SIMPLE_RANGE = /^([\^~])(\d+)\.(\d+)\.(\d+)$/;
function rangeCeiling(range) {
    const m = range.match(SIMPLE_RANGE);
    if (!m) return null;
    const [op, A, B, C] = [m[1], +m[2], +m[3], +m[4]];
    if (op === "~") return [A, B + 1, 0];
    if (A > 0) return [A + 1, 0, 0];
    if (B > 0) return [0, B + 1, 0];
    return [0, 0, C + 1];
}
const reachesPast = (latest, ceil) => { const L = triplet(latest); for (let i = 0; i < 3; i += 1) { if ((L[i] || 0) !== ceil[i]) return (L[i] || 0) > ceil[i]; } return true; };

function satisfies(v, range) {
    const parts = range.split("||").map((s) => s.trim());
    let known = false;
    for (const part of parts) {
        if (isExact(part)) { known = true; if (cmp(v, part) === 0) return true; continue; }
        if (SIMPLE_RANGE.test(part)) {
            known = true;
            if (cmp(v, part) >= 0 && !reachesPast(v, rangeCeiling(part))) return true;
            continue;
        }
        const m = part.match(/^>=\s*(\d+\.\d+\.\d+)(?:\s+<\s*(\d+\.\d+\.\d+))?$/);
        if (m) {
            known = true;
            if (cmp(v, m[1]) >= 0 && (m[2] === undefined || cmp(v, m[2]) < 0)) return true;
            continue;
        }
    }
    return known ? false : null;
}

const npmCache = new Map();
function npmLatest(name) {
    if (npmCache.has(name)) return npmCache.get(name);
    let v = null;
    try { v = execFileSync("npm", ["view", name, "version"], { encoding: "utf-8" }).trim(); } catch { /* unpublished */ }
    npmCache.set(name, v);
    return v;
}

function cap(cmd, a, cwd) {
    try { return execFileSync(cmd, a, { cwd, encoding: "utf-8" }); }
    catch (e) { return `${e.stdout ?? ""}` || `${e.stderr ?? ""}`; }
}

function auditFresh(pj) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "plurnk-audit-"));
    try {
        const slim = {
            name: pj.name,
            version: pj.version || "0.0.0",
            dependencies: pj.dependencies || {},
            optionalDependencies: pj.optionalDependencies || {},
        };
        writeFileSync(path.join(tmp, "package.json"), JSON.stringify(slim));
        cap("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund", "--ignore-scripts"], tmp);
        return JSON.parse(cap("npm", ["audit", "--json"], tmp));
    } catch { return null; }
    finally { rmSync(tmp, { recursive: true, force: true }); }
}

let issues = 0;

if (runPins) {
    console.log("PINS — exact pins trailing npm-latest\n");
    const stale = [];
    for (const { slug, pj } of pkgs) {
        for (const field of FIELDS) {
            for (const [name, range] of Object.entries(pj[field] || {})) {
                if (!isExact(range) || isWaived(name)) continue;
                const latest = npmLatest(name);
                if (latest && cmp(range, latest) < 0) stale.push({ slug, field, name, range, latest });
            }
        }
    }
    if (!stale.length) console.log("  none — every exact pin matches npm-latest.");
    for (const s of stale) console.log(`  STALE  ${s.slug}  [${s.field}]  ${s.name}  pins ${s.range} → npm ${s.latest}`);
    issues += stale.length;
    console.log("");

    console.log("EXTERNAL — third-party caret/tilde ranges trailing npm-latest\n");
    const extStale = [];
    for (const { slug, pj } of pkgs) {
        for (const field of FIELDS) {
            for (const [name, range] of Object.entries(pj[field] || {})) {
                if (name.startsWith("@plurnk/") || isWaived(name)) continue;
                const ceil = rangeCeiling(range);
                if (!ceil) continue;
                const latest = npmLatest(name);
                if (latest && reachesPast(latest, ceil)) extStale.push({ slug, field, name, range, latest });
            }
        }
    }
    if (!extStale.length) console.log("  none — every simple caret/tilde range still reaches npm-latest.");
    for (const s of extStale) console.log(`  STALE  ${s.slug}  [${s.field}]  ${s.name}  range ${s.range} → npm ${s.latest}`);
    issues += extStale.length;
    console.log("");

    console.log("LOCKFILES — standalone package-lock.json direct dependencies trailing npm-latest\n");
    const lockStale = [];
    for (const { dir, slug, pj, standalone } of pkgs) {
        if (!standalone) continue;
        const lockPath = path.join(dir, "package-lock.json");
        if (!existsSync(lockPath)) continue;
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        for (const field of ["dependencies", "devDependencies"]) {
            for (const name of Object.keys(pj[field] || {})) {
                if (isWaived(name)) continue;
                const latest = npmLatest(name);
                const locked = lock.packages?.[`node_modules/${name}`]?.version;
                if (latest && locked && locked !== latest) {
                    lockStale.push({ slug, field, name, locked, latest });
                }
            }
        }
    }
    if (!lockStale.length) console.log("  none — every standalone package-lock.json resolves direct deps to npm-latest.");
    for (const s of lockStale) console.log(`  STALE  ${s.slug}  [${s.field}]  ${s.name}  locked ${s.locked} → npm ${s.latest}`);
    issues += lockStale.length;
    console.log("");

    console.log("PEERS — extension peer ranges vs the core tip\n");
    const CORE = "@plurnk/plurnk-mimetypes";
    const localCore = pkgs.find((p) => p.pj.name === CORE)?.pj.version;
    const npmCore = npmLatest(CORE);
    const coreTip = localCore && npmCore ? (cmp(localCore, npmCore) >= 0 ? localCore : npmCore) : (localCore ?? npmCore);
    const peerStale = [];
    if (coreTip) {
        for (const { slug, pj } of pkgs) {
            const range = pj.peerDependencies?.[CORE];
            if (!range) continue;
            const ok = satisfies(coreTip, range);
            if (ok === false) peerStale.push({ slug, range });
        }
    }
    if (!peerStale.length) console.log(`  none — every peer range admits core ${coreTip}.`);
    for (const s of peerStale) console.log(`  STALE  ${s.slug}  peer "${s.range}" rejects core ${coreTip}`);
    issues += peerStale.length;
    console.log("");

    const hasGrammars = existsSync(path.join(root, "plurnk-mimetypes-grammar-bash", "package.json"));
    if (hasGrammars) {
        console.log("GRAMMARS — upstream .grammar-pin commits vs upstream stable release tags\n");
        const probes = await runGrammarLifecycle({ check: true, frameworkRoot, grammarsRoot: root });
        const behind = probes.filter((p) => p.state === "behind");
        if (!behind.length) console.log(`  none — all ${probes.length} grammar packages match upstream latest stable tag.`);
        for (const b of behind) console.log(`  STALE  plurnk-mimetypes-grammar-${b.slug}  ${b.note}`);
        issues += behind.length;
        console.log("");
    }
}

if (runAudit) {
    console.log(`AUDIT — npm audit per mimetypes package (level: ${auditLevel})\n`);
    let auditable = 0;
    let flagged = 0;
    const RUNTIME = ["dependencies", "optionalDependencies"];
    for (const { slug, pj, isMimetype } of pkgs) {
        if (!isMimetype) continue;
        const thirdParty = RUNTIME.some((f) => Object.keys(pj[f] || {}).some((k) => !k.startsWith("@plurnk/")));
        if (!thirdParty) continue;
        auditable += 1;
        const report = auditFresh(pj);
        const counts = report?.metadata?.vulnerabilities;
        if (!counts) { console.log(`  audit-error  ${slug}  (registry resolve failed — unpublished @plurnk dep?)`); issues += 1; continue; }
        const atOrAbove = SEVERITIES.slice(levelIdx).reduce((n, s) => n + (counts[s] || 0), 0);
        if (atOrAbove === 0) continue;
        flagged += 1;
        issues += 1;
        const detail = Object.values(report.vulnerabilities ?? {})
            .filter((v) => SEVERITIES.indexOf(v.severity) >= levelIdx)
            .map((v) => `${v.name}@${v.range} (${v.severity})`)
            .join(", ");
        console.log(`  VULN  ${slug}  ${atOrAbove} ≥${auditLevel}: ${detail}`);
    }
    if (!flagged) console.log(`  none — ${auditable} packages with third-party deps audited clean.`);
    console.log("");
}

console.log(issues === 0 ? "OK — no dependency-health issues." : `FOUND ${issues} issue(s).`);
process.exit(issues === 0 ? 0 : 1);
