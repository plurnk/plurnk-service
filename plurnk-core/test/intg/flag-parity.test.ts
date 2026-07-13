// §operator-config-flag-parity — every PLURNK_SERVICE_* flag the code reads has a matching
// .env.defaults line and vice versa. A half-landed rename (code moved, template didn't, or a
// script-glob missed a file) fails HERE instead of silently at a user's boot — the exact class
// that let PLURNK_GBNF_DEBUG and the package.json prefixes drift during the family-prefix sweep.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The four partition flags are read via a `PLURNK_SERVICE_${k}` template literal, and MD_* via a
// startsWith prefix — a literal-token scan can't see them, so they're declared-dynamic here.
const DYNAMIC_READS = new Set(["PLURNK_SERVICE_CTX", "PLURNK_SERVICE_REASONING", "PLURNK_SERVICE_ASSISTANT", "PLURNK_SERVICE_SAFETY"]);
const DYNAMIC_PREFIXES = ["PLURNK_SERVICE_MD_", "PLURNK_SERVICE_SQLITE_"]; // MD_<alias> + sqlite knobs iterated by prefix

test("[§operator-config-flag-parity] every PLURNK_SERVICE_* the code reads is in .env.defaults, and vice versa", () => {
    const template = readFileSync(`${root}/.env.defaults`, "utf8");
    // Declared: active `PLURNK_SERVICE_X=` and commented `# PLURNK_SERVICE_X=` lines.
    const declared = new Set(
        [...template.matchAll(/^#?\s*(PLURNK_SERVICE_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
    );

    // Read: literal PLURNK_SERVICE_* tokens across the service source (not tests).
    const srcFiles = execSync("git ls-files | grep -E '^src/.*\\.(ts|sql)$'", { cwd: root, encoding: "utf8", env: hermeticGitEnv() }).trim().split("\n");
    const read = new Set<string>();
    for (const f of srcFiles) {
        for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/\bPLURNK_SERVICE_[A-Z0-9_]+\b/g)) read.add(m[0]);
    }

    const underDynamicPrefix = (flag: string) => DYNAMIC_PREFIXES.some((p) => flag.startsWith(p) && flag !== p.slice(0, -1));

    // Every declared flag is read somewhere (literal, dynamic, or under a prefix-iterated family).
    const declaredNotRead = [...declared].filter((f) => !read.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(declaredNotRead, [], `declared in .env.defaults but never read by src (dead flags?): ${declaredNotRead.join(", ")}`);

    // Every literal read has a declared line (a code reader with no template entry = no CLI flag, no floor).
    const readNotDeclared = [...read].filter((f) => !declared.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(readNotDeclared, [], `read by src but missing from .env.defaults (no floor, no --flag): ${readNotDeclared.join(", ")}`);
});
