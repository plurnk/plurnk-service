#!/usr/bin/env node

// CLI wrapper for the Digest class (src/digest/Digest.ts). The class is the importable surface
// (consumed by plurnk-bench via the "@plurnk/plurnk-service/digest" subpath export, #303); this
// thin entry is the dev/test CLI (npm run test:digest). Default DB = the SERVICE's DB
// (PLURNK_DB_PATH, ~/.plurnk/plurnk.db floor), NOT the repo-local db; exit-1 on a missing DB.
import Digest from "../src/digest/Digest.ts";

if (import.meta.main) {
    try {
        // argv[3] = optional output dir, so multi-DB triage writes side-by-side reports
        // instead of clobbering test/digest/ per invocation.
        Digest.run({ dbPath: process.argv[2] ?? Digest.defaultDbPath(), ...(process.argv[3] !== undefined ? { digestDir: process.argv[3] } : {}) });
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
    }
}
