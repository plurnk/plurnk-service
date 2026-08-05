#!/usr/bin/env node

// CLI wrapper for the Digest class (src/digest/Digest.ts). The class is the importable
// "@plurnk/plurnk-service/digest" surface ({§digest-programmatic-surface}); this thin entry is
// the dev/test CLI (npm run test:digest). Default DB = the SERVICE's DB
// (PLURNK_SERVICE_DB_PATH, ~/.plurnk/plurnk.db floor), NOT the repo-local db; exit-1 on a missing DB.
//
// --requiem writes the out-of-band forensic interview artifacts in {§digest-requiem}.
import Digest from "../src/digest/Digest.ts";
import EnvDefaults from "../src/core/env-defaults.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (import.meta.main) {
    void (async () => {
        try {
            // The assembled .env.defaults floor ({§operator-config-env-defaults}) — the requiem
            // interview instantiates the active provider, whose knob defaults live in ITS file.
            const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
            EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, resolve(root, "..", "node_modules"))));
            const requiem = process.argv.includes("--requiem");
            // positional args (DB path, then optional output dir) — flags filtered out so a
            // multi-DB triage still writes side-by-side reports instead of clobbering test/digest/.
            const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
            const opts = { dbPath: positionals[0] ?? Digest.defaultDbPath(), ...(positionals[1] !== undefined ? { digestDir: positionals[1] } : {}) };
            Digest.run(opts);
            if (requiem) {
                const { path, reportPath, workers } = await Digest.requiem(opts);
                process.stdout.write(`requiem: interviewed ${workers} worker(s) -> ${path}, ${reportPath}\n`);
            }
        } catch (err) {
            process.stderr.write(`${(err as Error).message}\n`);
            process.exit(1);
        }
    })();
}
