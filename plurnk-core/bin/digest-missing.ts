#!/usr/bin/env node

// Recovery tool for benchmark processes interrupted before harness cleanup.
// Normal live/demo cleanup always writes a digest; this finds any immediate
// benchmark child that has a database but no digest and completes that step.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Digest from "../src/digest/Digest.ts";

export const missingDigestDirs = (benchmarks: string): string[] => {
    if (!existsSync(benchmarks)) return [];
    return readdirSync(benchmarks, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(benchmarks, entry.name))
        .filter((dir) => existsSync(join(dir, "plurnk.db")) && !existsSync(join(dir, "digest", "digest.json")))
        .toSorted();
};

// {§share}: the digest never deletes, so recovery discards an interrupted partial digest itself.
export const recoverDigest = (dir: string): void => {
    const digestDir = join(dir, "digest");
    rmSync(digestDir, { recursive: true, force: true });
    Digest.run({ dbPath: join(dir, "plurnk.db"), digestDir });
};

if (import.meta.main) {
    const benchmarks = process.env.PLURNK_BENCHMARKS
        ?? resolve(import.meta.dirname, "../../../..", "benchmarks");
    const missing = missingDigestDirs(benchmarks);
    for (const dir of missing) {
        process.stderr.write(`digest:missing: ${dir}\n`);
        recoverDigest(dir);
    }
    process.stderr.write(`digest:missing: recovered ${missing.length} specimen(s) under ${benchmarks}\n`);
}
