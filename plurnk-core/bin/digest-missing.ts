#!/usr/bin/env node

// Recovery tool for benchmark processes interrupted before harness cleanup.
// Normal live/demo cleanup always writes a digest; this finds any immediate
// benchmark child that has a database but no digest and completes that step.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Digest from "../src/digest/Digest.ts";

export const missingDigestDirs = (benchmarks: string): string[] => {
    if (!existsSync(benchmarks)) return [];
    return readdirSync(benchmarks, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(benchmarks, entry.name))
        .filter((dir) => existsSync(join(dir, "plurnk.db")) && !existsSync(join(dir, "digest")))
        .toSorted();
};

if (import.meta.main) {
    const benchmarks = process.env.PLURNK_BENCHMARKS
        ?? resolve(import.meta.dirname, "../../../..", "benchmarks");
    const missing = missingDigestDirs(benchmarks);
    for (const dir of missing) {
        process.stderr.write(`digest:missing: ${dir}\n`);
        Digest.run({ dbPath: join(dir, "plurnk.db"), digestDir: join(dir, "digest") });
    }
    process.stderr.write(`digest:missing: recovered ${missing.length} specimen(s) under ${benchmarks}\n`);
}
