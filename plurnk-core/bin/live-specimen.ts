#!/usr/bin/env node
// The matrix selector's driver: run ONE named live specimen and propagate its
// verdict. Usage: `npm run test:live:specimen -- <test-name-pattern>`

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { liveSpecimenInvocation } from "../src/matrix/live-specimen.ts";

const pattern = process.argv[2] ?? "";
if (pattern.length === 0) {
    console.error("usage: npm run test:live:specimen -- <test-name-pattern>");
    process.exit(2);
}
if (!existsSync("test/live")) {
    console.error("live-specimen: run from the plurnk-core workspace (npm run test:live:specimen)");
    process.exit(2);
}
const { args, env } = liveSpecimenInvocation(pattern);
const child = spawn("node", args, { env: { ...process.env, ...env }, stdio: "inherit" });
child.once("exit", (code, signal) => {
    if (signal !== null) {
        console.error(`live-specimen: terminated by ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});
