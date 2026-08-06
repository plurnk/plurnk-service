// The configured-provider packet matrix's deterministic single-specimen
// selector ({§provider-conformance-matrix}). The matrix procedure must run ONE
// named live specimen without replaying the whole tier: npm appends trailing
// arguments AFTER a script's expanded file list, so `--test-name-pattern` alone
// lands in a position that does not narrow the suite. This builder inserts the
// pattern BEFORE the expanded live file list in otherwise the exact test:live
// invocation, keeping the standard gate command unchanged.

import { readdirSync } from "node:fs";

const LIVE_ENV = {
    PLURNK_SERVICE_POLICY: "../plurnk-meta/PLURNK_PERSONALITY.md",
} as const;

// The exact file set the `test:live` script's shell glob selects — expanded
// deterministically here (never a shell glob) so pattern position is the only
// difference from the standard command.
export const liveSpecimenInvocation = (pattern: string): { args: string[]; env: typeof LIVE_ENV } => {
    const files = readdirSync("test/live").filter((f) => f.endsWith(".test.ts")).sort();
    if (files.length === 0) throw new Error("no live specimens found under test/live");
    const home = process.env.HOME ?? "";
    return {
        args: [
            "--conditions=plurnk-dev",
            "--import=./test/floor.ts",
            "--env-file-if-exists=.env.defaults",
            `--env-file-if-exists=${home}/.plurnk/.env`,
            "--env-file-if-exists=.env",
            "--env-file-if-exists=.env.test",
            "--test",
            "--test-concurrency=1",
            "--test-name-pattern",
            pattern,
            ...files.map((f) => `test/live/${f}`),
        ],
        env: LIVE_ENV,
    };
};
