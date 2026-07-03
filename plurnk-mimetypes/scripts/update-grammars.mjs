#!/usr/bin/env node
// Refresh ALL @plurnk/plurnk-mimetypes-grammar-* packages to upstream's latest
// release in one command — locally, no CI. For each grammar that's behind:
// advance the pin, rebuild + verify the WASM (build:wasm uses docker emscripten
// when emcc is absent), and open a PR. Publishing each bump stays manual (OTP).
//
//   npm run grammars:check    # read-only: report which grammars are behind
//   npm run grammars:update   # for each behind: bump + rebuild + verify + open PR
//   ... -- --only python      # restrict to one grammar
//
// Config: PLURNK_MIMETYPES_GRAMMARS_ROOT (.env.example) — the directory holding the
// grammar repos. Defaults to this checkout's parent (the usual side-by-side
// layout). Loaded via Node's built-in process.loadEnvFile().
import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(); } catch { /* no .env — fine */ }
// Rename tripwires (family-prefix sweep): old knob names crash with a pointer,
// never silently ignored (a stale FAMILY_ROOT would silently scan the wrong dir).
for (const old of ["PLURNK_AUDIT_LEVEL", "PLURNK_FAMILY_ROOT", "PLURNK_GRAMMARS_ROOT"]) {
    if (process.env[old] !== undefined) throw new Error(`${old} was renamed to ${old.replace("PLURNK_", "PLURNK_MIMETYPES_")} (family-prefix convention); update the environment.`);
}


const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PLURNK_MIMETYPES_GRAMMARS_ROOT
    ? path.resolve(process.env.PLURNK_MIMETYPES_GRAMMARS_ROOT)
    : path.resolve(here, "..", "..");

const names = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("plurnk-mimetypes-grammar-"))
    .map((e) => e.name)
    .filter((n) => !only || n === only || n === `plurnk-mimetypes-grammar-${only}`)
    .sort();

const cap = (cmd, a, cwd) => {
    try { return { ok: true, out: execFileSync(cmd, a, { cwd, encoding: "utf-8" }) }; }
    catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message) }; }
};

const results = [];
for (const name of names) {
    const dir = path.join(root, name);
    const slug = name.replace("plurnk-mimetypes-grammar-", "");

    const probe = cap("node", ["scripts/update-pin.mjs", "--check"], dir);
    if (!probe.ok) { results.push({ slug, state: "error", note: probe.out.trim().split("\n").pop() }); continue; }
    const bump = probe.out.match(/^BUMP .*/m)?.[0];
    if (!bump) { results.push({ slug, state: /up to date/.test(probe.out) ? "current" : "no-release-tags" }); continue; }
    if (check) { results.push({ slug, state: "behind", note: bump }); continue; }

    // Full refresh to MAIN, version-bumped and ready to publish: write the
    // pin, rebuild + verify, bump the patch version, commit to main, push.
    // The only step left is `npm publish` (OTP).
    cap("node", ["scripts/update-pin.mjs"], dir);
    const build = cap("npm", ["run", "build:wasm"], dir);
    if (!build.ok) { results.push({ slug, state: "build-failed", note: build.out.trim().split("\n").slice(-2).join(" ") }); continue; }
    const verify = cap("npm", ["run", "verify:wasm"], dir);
    if (!verify.ok) { results.push({ slug, state: "verify-failed" }); continue; }

    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const [maj, min, pat] = pkg.version.split(".").map(Number);
    pkg.version = `${maj}.${min}.${pat + 1}`;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);

    cap("git", ["checkout", "main"], dir);
    cap("git", ["add", "-A"], dir);
    cap("git", ["commit", "-m", `chore: grammar v${pkg.version} — pin + wasm to upstream latest\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`], dir);
    const push = cap("git", ["push", "origin", "main"], dir);
    results.push({ slug, state: push.ok ? "ready" : "push-failed", note: `v${pkg.version}${push.ok ? " pushed — npm publish to ship" : ""}` });
}

// Summary
const by = (s) => results.filter((r) => r.state === s).map((r) => r.slug);
console.log(`\n${check ? "CHECK" : "UPDATE"} — ${names.length} grammar packages under ${root}`);
for (const r of results) console.log(`  ${r.state.padEnd(15)} ${r.slug}${r.note ? "  " + r.note : ""}`);
console.log(`\nbehind=${by("behind").length} ready=${by("ready").length} current=${by("current").length + by("no-release-tags").length} failed=${by("build-failed").length + by("verify-failed").length + by("error").length + by("push-failed").length}`);
if (!check && by("ready").length > 0) console.log(`\nReady to ship: cd into each and \`npm publish\` (OTP), or run \`npm run grammars:publish\`.`);
