#!/usr/bin/env node
// Two deterministic dependency-health checks across the @plurnk/plurnk-mimetypes
// family — run before a publish window so nothing ships stale or vulnerable.
// Both failure modes are baked in here on purpose: neither relies on anyone
// remembering to also run `npm audit`.
//
//   1. PINS  — first-party EXACT pins that trail npm-latest. The aggregator
//      (-all) and the framework floor exact-pin their handler/grammar children;
//      when a child publishes, those pins silently fall behind (the re-pin
//      treadmill — it stranded the text-html floor a content-channel release
//      behind). Caret/range floors (^x, ~x, >=x) are MINIMUMS, intentionally
//      below latest — never flagged here (see EXTERNAL for the range half).
//   2. EXTERNAL — third-party SIMPLE caret/tilde ranges (^x.y.z / ~x.y.z) whose
//      ceiling now trails npm-latest: a new major/minor shipped PAST the range,
//      so the range itself is stale and needs a conscious bump. This is the half
//      PINS skips on purpose — the gap that let web-tree-sitter drift unseen.
//      Lockfile-lag WITHIN a still-valid range is the per-repo `npm outdated`
//      prepublishOnly gate's job (needs an install); this no-install sweep only
//      sees package.json. Union/compound ranges (`||`, `>=`, `*`) are skipped.
//   3. AUDIT — `npm audit` per family package that carries third-party deps.
//      Catches a transitive advisory rooted in a handler at the source (e.g. the
//      text-gherkin → @cucumber/gherkin → @cucumber/messages → uuid chain) that
//      a version-pin scan structurally cannot see. The COMBINED-tree audit is
//      the install root's job (plurnk-service); this is the per-package half.
//
//   npm run deps:check                 # both checks
//   npm run deps:check -- --only pins
//   npm run deps:check -- --only audit
//
// Config (.env.example): PLURNK_FAMILY_ROOT (dir holding the side-by-side repos,
// default = this checkout's parent), PLURNK_AUDIT_LEVEL (default "moderate").
// Exits non-zero if any issue is found — usable as a gate.
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const runPins = !only || only === "pins";
const runAudit = !only || only === "audit";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const auditLevel = process.env.PLURNK_AUDIT_LEVEL || "moderate";
const levelIdx = Math.max(0, SEVERITIES.indexOf(auditLevel));

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PLURNK_FAMILY_ROOT
    ? path.resolve(process.env.PLURNK_FAMILY_ROOT)
    : path.resolve(here, "..", "..");

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Discover every @plurnk/plurnk-mimetypes-* package (the framework, -all,
// grammars, handlers, embeddings) under the family root.
const pkgs = [];
for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    const pjPath = path.join(dir, "package.json");
    if (!existsSync(pjPath) || !statSync(dir).isDirectory()) continue;
    try {
        const pj = JSON.parse(readFileSync(pjPath, "utf-8"));
        if (pj.name?.includes("plurnk-mimetypes")) pkgs.push({ dir, slug: name, pj });
    } catch (e) { console.error(`  parse fail ${name}: ${e.message}`); }
}

// 3-part numeric compare on the leading x.y.z (ignores prerelease/range chars).
const triplet = (v) => v.replace(/^[\^~>=<\s]+/, "").split("-")[0].split(".").map(Number);
const cmp = (a, b) => { const [A, B] = [triplet(a), triplet(b)]; for (let i = 0; i < 3; i += 1) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); } return 0; };
const isExact = (range) => /^\d/.test(range); // exact pin, not ^ ~ >= * workspace: file:

// Exclusive upper bound of a SIMPLE caret/tilde range (^x.y.z / ~x.y.z), per
// npm semver semantics (^0.y caps at 0.(y+1), ^0.0.z at 0.0.(z+1)). null for
// any compound/complex range (unions `||`, `>=`, `*`, `x`) — deliberately
// skipped, not guessed: better to under-flag a weird range than false-positive.
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
// latest (string) >= ceiling (triplet array) → range can't reach latest → stale.
const reachesPast = (latest, ceil) => { const L = triplet(latest); for (let i = 0; i < 3; i += 1) { if ((L[i] || 0) !== ceil[i]) return (L[i] || 0) > ceil[i]; } return true; };

const npmCache = new Map();
function npmLatest(name) {
    if (npmCache.has(name)) return npmCache.get(name);
    let v = null;
    try { v = execFileSync("npm", ["view", name, "version"], { encoding: "utf-8" }).trim(); } catch { /* unpublished */ }
    npmCache.set(name, v);
    return v;
}

// Capture stdout even when the command exits non-zero (npm audit does so when it
// finds anything).
function cap(cmd, a, cwd) {
    try { return execFileSync(cmd, a, { cwd, encoding: "utf-8" }); }
    catch (e) { return `${e.stdout ?? ""}` || `${e.stderr ?? ""}`; }
}

// Audit a package's PROD dependency closure exactly as a consumer resolves it:
// a published package strips its lockfile, so the consumer-accurate tree is a
// fresh resolve of `dependencies` + `optionalDependencies` (no devDeps, no
// peers) from the registry. `npm audit --package-lock-only` needs a lockfile to
// exist, so we synthesize one in a throwaway temp dir from a slimmed manifest —
// never touching the repo, never installing node_modules.
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
    console.log("PINS — first-party exact pins trailing npm-latest\n");
    // Gather unique first-party exact pins to minimize `npm view` calls.
    const stale = [];
    for (const { slug, pj } of pkgs) {
        for (const field of FIELDS) {
            for (const [name, range] of Object.entries(pj[field] || {})) {
                if (!name.startsWith("@plurnk/") || !isExact(range)) continue;
                const latest = npmLatest(name);
                if (latest && cmp(range, latest) < 0) stale.push({ slug, field, name, range, latest });
            }
        }
    }
    if (!stale.length) console.log("  none — every first-party exact pin matches npm-latest.");
    for (const s of stale) console.log(`  STALE  ${s.slug}  [${s.field}]  ${s.name.replace("@plurnk/plurnk-mimetypes-", "")}  pins ${s.range} → npm ${s.latest}`);
    issues += stale.length;
    console.log("");

    // EXTERNAL — third-party simple caret/tilde ranges whose ceiling now trails
    // npm-latest (a new major/minor shipped past the range). The PINS check
    // above ignores ranges by design (range floors are minimums); this catches
    // the other half — a *range* gone stale, needing a conscious bump (the gap
    // that let web-tree-sitter drift). Lockfile-lag WITHIN a range is the
    // per-repo `npm outdated` gate's job, not this no-install family sweep.
    console.log("EXTERNAL — third-party caret/tilde ranges trailing npm-latest\n");
    const extStale = [];
    for (const { slug, pj } of pkgs) {
        for (const field of FIELDS) {
            for (const [name, range] of Object.entries(pj[field] || {})) {
                if (name.startsWith("@plurnk/")) continue;
                const ceil = rangeCeiling(range);
                if (!ceil) continue; // exact pins / unions / complex ranges — skip
                const latest = npmLatest(name);
                if (latest && reachesPast(latest, ceil)) extStale.push({ slug, field, name, range, latest });
            }
        }
    }
    if (!extStale.length) console.log("  none — every simple caret/tilde range still reaches npm-latest.");
    for (const s of extStale) console.log(`  STALE  ${s.slug}  [${s.field}]  ${s.name}  range ${s.range} → npm ${s.latest}`);
    issues += extStale.length;
    console.log("");
}

if (runAudit) {
    console.log(`AUDIT — npm audit per family package (level: ${auditLevel})\n`);
    let auditable = 0;
    let flagged = 0;
    // The shipping surface only: a published package strips its lockfile, so a
    // consumer resolves third-party deps fresh from `dependencies` /
    // `optionalDependencies` ranges. devDeps don't ship; peers are consumer-
    // chosen. --package-lock-only audits that fresh resolution (no install, no
    // committed lockfile required, no repo mutation).
    const RUNTIME = ["dependencies", "optionalDependencies"];
    for (const { dir, slug, pj } of pkgs) {
        const thirdParty = RUNTIME.some((f) => Object.keys(pj[f] || {}).some((k) => !k.startsWith("@plurnk/")));
        if (!thirdParty) continue; // grammars / -all carry no third-party runtime surface
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
