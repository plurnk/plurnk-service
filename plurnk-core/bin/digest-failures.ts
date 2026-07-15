// §archaeology (#410) — digest every PRESERVED failure run that lacks one. The live/demo harness
// births + KEEPS a failing run in benchmarks/run<N>-<lane>/ (preserve-default; passing runs are
// swept at worker exit). This renders each keeper's digest + requiem so a failure is analysis-ready
// with no manual step. Idempotent: a run that already has digest/ is skipped, so it's safe to re-run
// (and safe to chain after a live/demo run regardless of outcome).
import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const BENCHMARKS = process.env.PLURNK_BENCHMARKS ?? resolve(homedir(), "repo/plurnk/benchmarks");
const LANE = process.env.PLURNK_LANE ?? "core";
const runDir = new RegExp(`^run\\d+-${LANE}$`);

let count = 0;
for (const entry of existsSync(BENCHMARKS) ? readdirSync(BENCHMARKS) : []) {
    if (!runDir.test(entry)) continue;
    const dir = join(BENCHMARKS, entry);
    if (!existsSync(join(dir, "plurnk.db")) || existsSync(join(dir, "digest"))) continue; // no db, or already digested
    process.stderr.write(`digest-failures: ${entry}\n`);
    spawnSync("node", ["--conditions=plurnk-dev", "bin/digest.ts", join(dir, "plurnk.db"), join(dir, "digest"), "--requiem"], { stdio: "inherit" });
    count++;
}
process.stderr.write(`digest-failures: ${count} preserved run(s) digested (${BENCHMARKS}, lane ${LANE})\n`);
