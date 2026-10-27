#!/usr/bin/env node

// Recovery tool for benchmark processes interrupted before harness cleanup.
// Normal live/demo cleanup always writes a digest; this finds any benchmark session, directly under
// the home or inside a tier run ({§test-artifact-retention}), that has a database but no digest and completes
// that step.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { benchmarksRoot } from "../../scripts/lib/test-artifacts.ts";
import { usage } from "../../scripts/lib/usage.mjs";

usage(import.meta, `
usage: npm run digest:missing   (from plurnk-core)
Completes the digest for any benchmark session, directly under the home or inside a tier run, that has a database but no digest ({§test-artifact-retention}).
Reads: the benchmark home.
Writes: digest/ beside each such database.
`);

const directories = (parent: string): string[] =>
    readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(parent, entry.name));

export const missingDigestDirs = (benchmarks: string): string[] => {
    if (!existsSync(benchmarks)) return [];
    const children = directories(benchmarks);
    return [...children, ...children.filter((dir) => dir.startsWith(join(benchmarks, "tier-"))).flatMap(directories)]
        .filter((dir) => existsSync(join(dir, "plurnk.db")) && !existsSync(join(dir, "digest", "digest.json")))
        .toSorted();
};

// {§share}: the digest never deletes, so recovery discards an interrupted partial digest itself.
export const recoverDigest = (dir: string): void => {
    const digestDir = join(dir, "digest");
    rmSync(digestDir, { recursive: true, force: true });
    Digest.run({ openEvidence: EvidenceReader.open, dbPath: join(dir, "plurnk.db"), digestDir });
};

if (import.meta.main) {
    const benchmarks = benchmarksRoot();
    const missing = missingDigestDirs(benchmarks);
    for (const dir of missing) {
        process.stderr.write(`digest:missing: ${dir}\n`);
        recoverDigest(dir);
    }
    process.stderr.write(`digest:missing: recovered ${missing.length} specimen(s) under ${benchmarks}\n`);
}
