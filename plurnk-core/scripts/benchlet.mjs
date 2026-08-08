#!/usr/bin/env node
// test:benchlet — run the DeepSWE benchlet against this checkout.
// The benchlet lives in the plurnk-bench repo (PLURNK_BENCH_ROOT); it drives
// the daemon through candidate.mjs, which boots its own daemon+client pair.
// This script is a thin pointer — the benchlet owns the task, the model loop,
// the oracle, and the digest.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const benchRoot = process.env.PLURNK_BENCH_ROOT ?? resolve(homedir(), "prj/repo/plurnk-bench");
if (!existsSync(resolve(benchRoot, "deepswe/benchlet.ts"))) {
    console.error(`benchlet not found at ${benchRoot} — set PLURNK_BENCH_ROOT to the plurnk-bench checkout`);
    process.exit(2);
}

const serviceRoot = resolve(import.meta.dirname, "../..");
const clientRoot = process.env.PLURNK_CLIENT_ROOT ?? resolve(homedir(), "ptl/plurnk");

const result = spawnSync(process.execPath, [
    "--conditions=plurnk-dev",
    resolve(benchRoot, "deepswe/benchlet.ts"),
    ...process.argv.slice(2),
], {
    cwd: benchRoot,
    env: {
        ...process.env,
        PLURNK_BENCHLET_SERVICE_ROOT: serviceRoot,
        PLURNK_BENCHLET_CLIENT_ROOT: clientRoot,
    },
    stdio: "inherit",
});
process.exit(result.status ?? 1);
