#!/usr/bin/env node
//
// Unify the `§` squiggle onto ONE convention: terse kebab tags, zero digits.
// Today `§` carries three shapes — numeric section refs (`§13.4`), bracketed
// promise anchors (`{§13.4-discover}`), and unbracketed prose anchor refs
// (`(§2.2-signal-wired)`). All collapse into one tag namespace: a section is
// `§edit`, a promise under it is `§edit-noop-304`. Hierarchy is by prefix, not by
// number — renumbering is a non-event and no structural information is lost (the
// section a promise lives under is encoded in its tag prefix, as the number was).
//
// Driven from HEAD (which still holds the numbers) so the mapping is total and
// deterministic; applied to the working tree. Only `§…` patterns are touched —
// feature code in the concurrently-edited files is never rewritten. The bare
// forms my earlier (wrong) strip left in those un-restored files are recovered
// from HEAD too. Idempotent. Dry-run by default; pass --apply to write.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve, join, extname, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SELF = resolve(import.meta.url.slice("file://".length));
const APPLY = process.argv.includes("--apply");

// Section number -> terse, globally-unique kebab tag. Hand-authored for brevity;
// title collisions (manifest, consumption-surface) are domain-qualified.
const SECTION_TAG = Object.freeze({
    "0": "glossary",
    "0.1": "lifecycle-terms", "0.2": "storage-terms", "0.3": "state-terms",
    "0.4": "authority-terms", "0.5": "engine-rails", "0.6": "packet-terms", "0.7": "test-taxonomy",
    "1": "arch",
    "1.1": "ecosystem", "1.2": "in-process", "1.3": "actor-boundary", "1.4": "machine-processes",
    "2": "provider",
    "2.1": "provider-surface", "2.2": "provider-guarantees", "2.3": "provider-instantiation", "2.4": "mock-provider",
    "3": "scheme",
    "3.1": "scheme-manifest", "3.2": "crud", "3.3": "op-methods", "3.4": "orchestration",
    "3.5": "send-dispatch", "3.6": "scheme-surface",
    "4": "mimetype",
    "4.1": "mimetype-manifest", "4.2": "mimetype-methods", "4.3": "handler-bounds",
    "4.4": "handler-bundling", "4.5": "mimetype-surface",
    "5": "channels",
    "5.1": "per-entry-channels", "5.2": "no-visibility", "5.3": "channel-mimetype",
    "5.4": "channel-selection", "5.5": "channel-state",
    "6": "op",
    "6.1": "edit", "6.2": "read", "6.3": "open-fold", "6.4": "copy", "6.5": "move",
    "6.6": "find", "6.7": "send", "6.8": "exec", "6.9": "proposal",
    "7": "stream",
    "7.1": "subscriptions", "7.2": "chunk-accumulation", "7.3": "no-chunk-rows",
    "7.4": "deep-slices", "7.5": "stream-control", "7.6": "stream-constraints", "7.7": "live-updates",
    "8": "storage",
    "8.1": "ddl", "8.2": "sql-ts-boundary",
    "9": "plugin-discovery",
    "10": "bundled-set",
    "11": "grammar",
    "11.1": "grammar-provides", "11.2": "service-tracks",
    "12": "operator-config",
    "13": "rpc",
    "13.1": "transport", "13.2": "protocol", "13.3": "method-registration", "13.4": "discovery",
    "13.5": "methods", "13.6": "notifications", "13.7": "connection-lifecycle", "13.8": "errors", "13.9": "versioning",
    "14": "decisions",
    "14.1": "packet-assembly", "14.2": "tokenomics", "14.3": "membership", "14.4": "grinder",
    "14.5": "env-delta", "14.6": "edit-result-render", "14.7": "dual-yolo",
    "15": "packet",
    "15.1": "telemetry", "15.2": "requirements", "15.3": "persona",
    "16": "matcher",
    "16.1": "matcher-dispatch", "16.2": "matcher-result", "16.3": "slice-semantics", "16.4": "json-edit",
    "16.5": "ext-mimetype", "16.6": "render-rule", "16.7": "markdown-primitive",
    "16.8": "op-invariants", "16.9": "send-status-policy",
});

const sh = (cmd) => execSync(cmd, { encoding: "utf8", cwd: ROOT });

// validate: total over HEAD sections, globally unique
const headSpec = sh("git show HEAD:SPEC.md");
const missing = [...headSpec.matchAll(/^#+ §([0-9.]+) /gm)].map((m) => m[1]).filter((n) => !SECTION_TAG[n]);
if (missing.length) { console.error(`FATAL — sections with no tag: ${missing.join(", ")}`); process.exit(1); }
const vals = Object.values(SECTION_TAG);
const dupeTags = [...new Set(vals.filter((t, i) => vals.indexOf(t) !== i))];
if (dupeTags.length) { console.error(`FATAL — duplicate section tags: ${dupeTags.join(", ")}`); process.exit(1); }

// The 4 collisions my earlier strip disambiguated by hand — their bare working-
// tree form, so recovery resolves it back to the same target.
const PRIOR = { "6.1-noop-304": "edit-noop-304", "6.4-noop-304": "copy-noop-304",
    "6.4-missing-source-404": "copy-missing-source-404", "6.5-missing-source-404": "move-missing-source-404" };

// Build the recovery map from EVERY HEAD-tracked file: both bracketed anchors and
// unbracketed `§num-slug` prose refs. Numbered id -> target, and the bare form
// (what the wrong strip left) -> the same target.
const NUMBERED_ID = /[{[]§([\d.][\w.-]*)[}\]]|(?<![{[\w])§([\d.]+-[\w.-]+)/g;
const idToTarget = new Map();
const headTargets = [];
const trackedFiles = sh("git ls-files").split("\n").filter((f) => [".md", ".ts", ".mjs", ".js"].includes(extname(f)));
for (const f of trackedFiles) {
    let src; try { src = sh(`git show HEAD:${f}`); } catch { continue; }
    for (const m of src.matchAll(NUMBERED_ID)) {
        const id = m[1] ?? m[2];
        const parts = id.match(/^([\d.]+)-(.+)$/);
        if (!parts) continue;
        const [, sec, promise] = parts;
        if (!SECTION_TAG[sec]) { console.error(`FATAL — §${id} in ${f}: section ${sec} unmapped`); process.exit(1); }
        const target = `${SECTION_TAG[sec]}-${promise}`;
        if (f === "SPEC.md" && m[1]) headTargets.push(target);     // 1:1 guard over SPEC's bracketed anchors
        idToTarget.set(id, target);
        idToTarget.set(PRIOR[id] ?? id.replace(/^[\d.]+-/, ""), target);
    }
}
const dupeTargets = [...new Set(headTargets.filter((t, i) => headTargets.indexOf(t) !== i))];
if (dupeTargets.length) { console.error(`FATAL — distinct promises collapse: ${dupeTargets.join(", ")}`); process.exit(1); }
const targets = [...new Set(headTargets)];

const resolveAnchor = (id) => {
    if (idToTarget.has(id)) return idToTarget.get(id);
    const m = id.match(/^([\d.]+)-(.+)$/);
    if (m && SECTION_TAG[m[1]]) return `${SECTION_TAG[m[1]]}-${m[2]}`;
    return id;                                                      // already terse — idempotent
};

// bare section refs: longest-first so §16.9 wins over §16; allow a trailing
// period (sentence end) but not a decimal digit or an anchor `-slug`.
const nums = Object.keys(SECTION_TAG).toSorted((a, b) => b.length - a.length).map((n) => n.replace(/\./g, "\\."));
const SECTION_RE = new RegExp(`§(${nums.join("|")})(?![\\w-])(?!\\.\\d)`, "g");
const PROSE_ANCHOR_RE = /(?<![{[\w])§([\d.]+-[\w.-]+)/g;
const BRACKET_RE = /([{[])§([\w.-]+)([}\]])/g;

const transform = (s) => s
    .replace(BRACKET_RE, (_m, o, id, c) => `${o}§${resolveAnchor(id)}${c}`)
    .replace(PROSE_ANCHOR_RE, (_m, id) => `§${resolveAnchor(id)}`)
    .replace(SECTION_RE, (_m, n) => `§${SECTION_TAG[n]}`);

const SKIP = new Set(["node_modules", ".git", "dist"]);
const EXTS = new Set([".md", ".ts", ".mjs", ".js"]);
const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) out.push(...await walk(p)); }
        else if (EXTS.has(extname(e.name)) && p !== SELF) out.push(p);
    }
    return out;
};

let changed = 0;
for (const file of await walk(ROOT)) {
    const before = await readFile(file, "utf8");
    const after = transform(before);
    if (after === before) continue;
    changed++;
    console.log(`  ${APPLY ? "~" : "·"} ${relative(ROOT, file)}`);
    if (APPLY) await writeFile(file, after);
}
console.log(`\n${APPLY ? "applied" : "DRY-RUN"}: ${changed} files, ${targets.length} SPEC anchor targets, ${idToTarget.size / 2 | 0}± recovery entries, section tags unique.`);
console.log(APPLY ? "done." : "re-run with --apply to write.");
