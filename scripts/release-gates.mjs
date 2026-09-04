// Candidate-only release checks. The caller already built and ran the canonical
// deterministic test gate; this sweep proves dependency and packed-artifact facts
// plus the few package-specific checks that have no ordinary test-tier meaning.
// Usage: node scripts/release-gates.mjs [--only <pkg-dir>]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({ options: { only: { type: "string" } } });

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const dirs = values.only ? [values.only] : root.workspaces;

await run("node", ["scripts/package-build-policy.mjs"]);
const provenanceArgs = ["scripts/package-provenance.mjs", "--pack"];
if (values.only !== undefined) provenanceArgs.push("--only", values.only);
await run("node", provenanceArgs, { maxBuffer: 64 * 1024 * 1024 });
const publintArgs = ["scripts/package-publint.mjs"];
if (values.only !== undefined) publintArgs.push("--only", values.only);
await run("node", publintArgs, { maxBuffer: 64 * 1024 * 1024 });
// (#649): one deliberate, bounded audit. A rate-limited or unreachable
// advisory endpoint warns and continues — it must never hang or block a release; a genuine
// ≥moderate finding still fails the gate. (The endpoint drops over-limit requests instead
// of answering 429, and npm's default retries re-feed the limit.)
try {
    await run("npm", ["audit", "--audit-level=moderate"], {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, npm_config_audit: "true", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "60000" },
    });
} catch (cause) {
    const text = `${cause.stdout ?? ""}\n${cause.stderr ?? ""}`;
    const unreachable = /network timeout|audit endpoint returned an error|ETIMEDOUT|ECONNRESET|ERR_SOCKET_TIMEOUT|FETCH_ERROR|socket hang up|request to .* failed|timed out/iu.test(text);
    if (!unreachable) throw cause;
    console.warn(`release-gates: dependency audit UNREACHABLE — the advisory endpoint did not answer; continuing (#649). Re-run \`npm audit\` when it recovers.\n${text.trim().slice(0, 300)}`);
}

let gated = 0;
for (const dir of dirs) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.["release:check"] === undefined) continue;
    console.log(`  release-check ${pkg.name}`);
    await run("npm", ["run", "release:check", "-w", pkg.name], { maxBuffer: 64 * 1024 * 1024 });
    gated++;
}
console.log(`release-gates GREEN: dependency audit, package shape, packed projection, ${gated} package-specific check(s)`);
