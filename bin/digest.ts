#!/usr/bin/env node

// CLI wrapper for the Digest class (src/digest/Digest.ts). The class is the importable surface
// (consumed by plurnk-bench via the "@plurnk/plurnk-service/digest" subpath export, #303); this
// thin entry is the dev/test CLI (npm run test:digest). Default DB = the SERVICE's DB
// (PLURNK_DB_PATH, ~/.plurnk/plurnk.db floor), NOT the repo-local db; exit-1 on a missing DB.
//
// --requiem also writes requiem.md: the model's exit interview (each run's final packet + last
// emission, then asked to itemize the system's faults, unconstrained). Needs an active provider.
import Digest from "../src/digest/Digest.ts";

if (import.meta.main) {
    void (async () => {
        try {
            const requiem = process.argv.includes("--requiem");
            // positional args (DB path, then optional output dir) — flags filtered out so a
            // multi-DB triage still writes side-by-side reports instead of clobbering test/digest/.
            const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
            const opts = { dbPath: positionals[0] ?? Digest.defaultDbPath(), ...(positionals[1] !== undefined ? { digestDir: positionals[1] } : {}) };
            Digest.run(opts);
            if (requiem) {
                const { path, runs } = await Digest.requiem(opts);
                process.stdout.write(`requiem: interviewed ${runs} run(s) → ${path}\n`);
            }
        } catch (err) {
            process.stderr.write(`${(err as Error).message}\n`);
            process.exit(1);
        }
    })();
}
